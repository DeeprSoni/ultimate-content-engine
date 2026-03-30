#!/usr/bin/env node
// migrate.js — One-time migration from file storage to MongoDB
// Usage: MONGODB_URI=mongodb://... node migrate.js
// Idempotent: skips records that already exist in MongoDB

const fs = require('fs');
const path = require('path');
const { MongoClient } = require('mongodb');

const MONGODB_URI = process.env.MONGODB_URI;
const DATA_DIR = process.env.DATA_DIR || '/data';

if (!MONGODB_URI) {
  console.error('MONGODB_URI required. Set it in .env or pass as environment variable.');
  process.exit(1);
}

async function migrate() {
  const client = new MongoClient(MONGODB_URI, { maxPoolSize: 5 });
  await client.connect();
  const db = client.db();
  console.log('Connected to MongoDB');

  const tenantsDir = path.join(DATA_DIR, 'tenants');
  if (!fs.existsSync(tenantsDir)) {
    console.log('No tenants directory found. Nothing to migrate.');
    await client.close();
    return;
  }

  const tenants = fs.readdirSync(tenantsDir).filter(f => {
    try { return fs.statSync(path.join(tenantsDir, f)).isDirectory(); }
    catch { return false; }
  });

  console.log(`Found ${tenants.length} tenants to migrate`);

  for (const userId of tenants) {
    const tenantDir = path.join(tenantsDir, userId);
    console.log(`\nMigrating tenant: ${userId}`);

    // Migrate published posts
    const pubDir = path.join(tenantDir, 'published');
    await migrateDir(db, 'posts', pubDir, userId, (doc) => ({ ...doc, user_id: userId, status: 'published' }));

    // Migrate pending posts
    const pendDir = path.join(tenantDir, 'pending');
    await migrateDir(db, 'posts', pendDir, userId, (doc) => ({ ...doc, user_id: userId, status: doc.status || 'pending' }));

    // Migrate articles
    const artDir = path.join(tenantDir, 'articles');
    await migrateDir(db, 'articles', artDir, userId, (doc) => ({ ...doc, user_id: userId }));

    // Migrate decisions
    const decDir = path.join(tenantDir, 'decisions');
    await migrateDir(db, 'decisions', decDir, userId, (doc) => ({ ...doc, user_id: userId }));

    // Migrate stories
    const storiesFile = path.join(tenantDir, 'stories/stories.json');
    if (fs.existsSync(storiesFile)) {
      try {
        const stories = JSON.parse(fs.readFileSync(storiesFile, 'utf8'));
        if (stories.length > 0) {
          const existing = await db.collection('stories').countDocuments({ user_id: userId });
          if (existing === 0) {
            await db.collection('stories').insertMany(stories.map(s => ({ ...s, user_id: userId })));
            console.log(`  stories: ${stories.length} migrated`);
          } else {
            console.log(`  stories: already in MongoDB (${existing}), skipping`);
          }
        }
      } catch (e) { console.log(`  stories: error — ${e.message}`); }
    }

    // Migrate context
    const ctxFile = path.join(tenantDir, 'contexts/default.txt');
    if (fs.existsSync(ctxFile)) {
      try {
        const ctx = fs.readFileSync(ctxFile, 'utf8');
        await db.collection('contexts').updateOne(
          { user_id: userId },
          { $setOnInsert: { user_id: userId, content: ctx, created_at: new Date().toISOString() } },
          { upsert: true }
        );
        console.log(`  context: migrated`);
      } catch (e) { console.log(`  context: error — ${e.message}`); }
    }
  }

  // Migrate users
  const usersDir = path.join(DATA_DIR, 'users');
  if (fs.existsSync(usersDir)) {
    await migrateDir(db, 'users', usersDir, null, (doc) => ({ ...doc, email: (doc.email || '').toLowerCase() }));
  }

  // Create indexes
  await db.collection('users').createIndex({ email: 1 }, { unique: true }).catch(() => {});
  await db.collection('posts').createIndex({ user_id: 1, status: 1, created_at: -1 }).catch(() => {});
  await db.collection('decisions').createIndex({ user_id: 1, at: -1 }).catch(() => {});
  await db.collection('articles').createIndex({ user_id: 1, scouted_at: -1, status: 1 }).catch(() => {});
  await db.collection('stories').createIndex({ user_id: 1 }).catch(() => {});
  await db.collection('engagement').createIndex({ post_id: 1 }, { unique: true }).catch(() => {});

  console.log('\nMigration complete!');
  await client.close();
}

async function migrateDir(db, collection, dir, userId, transform) {
  if (!fs.existsSync(dir)) return;
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
  let migrated = 0, skipped = 0;

  for (const f of files) {
    try {
      const doc = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      const transformed = transform(doc);
      const idField = transformed.id || transformed._id || f.replace('.json', '');

      const exists = await db.collection(collection).findOne(
        transformed.id ? { id: transformed.id } : { _id: idField }
      );
      if (exists) { skipped++; continue; }

      if (!transformed.id && !transformed._id) transformed.id = idField;
      await db.collection(collection).insertOne(transformed);
      migrated++;
    } catch {}
  }

  if (migrated > 0 || skipped > 0) {
    console.log(`  ${collection}: ${migrated} migrated, ${skipped} skipped`);
  }
}

migrate().catch(e => {
  console.error('Migration failed:', e);
  process.exit(1);
});
