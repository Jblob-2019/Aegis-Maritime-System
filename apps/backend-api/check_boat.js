import mongoose from 'mongoose';

const MONGO_URI = 'mongodb://jana9380355915_db_user:2008sj2114@ac-twitwxh-shard-00-00.hl1i0u7.mongodb.net:27017,ac-twitwxh-shard-00-01.hl1i0u7.mongodb.net:27017,ac-twitwxh-shard-00-02.hl1i0u7.mongodb.net:27017/?ssl=true&authSource=admin';

async function run() {
  try {
    await mongoose.connect(MONGO_URI);
    console.log('✅ Connected to MongoDB!');

    const boatIdsToCheck = ['BOAT1', 'CLAUDE-TEST-01'];
    const registeredBoats = await mongoose.connection.db.collection('registered_boats').find({
      boatId: { $in: boatIdsToCheck }
    }).toArray();

    console.log('Registered Boats found:', JSON.stringify(registeredBoats, null, 2));
    
    await mongoose.connection.close();
  } catch (err) {
    console.error('❌ Error:', err);
    process.exit(1);
  }
}

run();
