import mongoose from 'mongoose';

const MONGO_URI = 'mongodb+srv://jana9380355915_db_user:2008sj2114@aegis-maritime-system.hl1i0u7.mongodb.net/?retryWrites=true&w=majority';

async function run() {
  try {
    await mongoose.connect(MONGO_URI);
    console.log('✅ Connected to MongoDB!');

    const boatId = 'CLAUDE-TEST-01';
    
    // Check if registered
    const registered = await mongoose.connection.db.collection('registered_boats').findOne({ boatId });
    
    if (registered) {
      console.log(`✅ Boat ${boatId} is already registered.`);
    } else {
      console.log(`❌ Boat ${boatId} is NOT registered. Adding it now...`);
      await mongoose.connection.db.collection('registered_boats').insertOne({
        boatId: boatId,
        registeredAt: new Date()
      });
      console.log(`✅ Successfully registered ${boatId}!`);
    }
    
    await mongoose.connection.close();
  } catch (err) {
    console.error('❌ Error:', err);
    process.exit(1);
  }
}

run();
