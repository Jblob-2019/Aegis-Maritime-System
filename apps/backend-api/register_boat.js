import mongoose from 'mongoose';

const MONGO_URI = 'mongodb://jana9380355915_db_user:2008sj2114@ac-twitwxh-shard-00-00.hl1i0u7.mongodb.net:27017,ac-twitwxh-shard-00-01.hl1i0u7.mongodb.net:27017,ac-twitwxh-shard-00-02.hl1i0u7.mongodb.net:27017/?ssl=true&authSource=admin';

async function run() {
  try {
    await mongoose.connect(MONGO_URI);
    console.log('✅ Connected to MongoDB!');

    const boatId = 'BOAT1';

    // Insert into boats
    await mongoose.connection.db.collection('boats').insertOne({
      boatId: boatId,
      lat: 0,
      lon: 0,
      timestamp: new Date()
    });
    console.log(`✅ Inserted ${boatId} into 'boats' collection`);

    // Insert into registered_boats (common name for registration checks)
    await mongoose.connection.db.collection('registered_boats').insertOne({
      boatId: boatId,
      registeredAt: new Date()
    });
    console.log(`✅ Inserted ${boatId} into 'registered_boats' collection`);

    // Also try registeredboats (no underscore)
    try {
      await mongoose.connection.db.collection('registeredboats').insertOne({ boatId: boatId });
      console.log(`✅ Inserted ${boatId} into 'registeredboats' collection`);
    } catch (e) {}

    await mongoose.connection.close();
  } catch (err) {
    console.error('❌ Error:', err);
  }
}

run();
