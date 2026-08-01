import mongoose from 'mongoose';
import 'dotenv/config';

const uri = "mongodb://jana9380355915_db_user:2008sj2114@ac-twitwxh-shard-00-00.hl1i0u7.mongodb.net:27017,ac-twitwxh-shard-00-01.hl1i0u7.mongodb.net:27017,ac-twitwxh-shard-00-02.hl1i0u7.mongodb.net:27017/?ssl=true&replicaSet=atlas-97a78w-shard-0&authSource=admin&retryWrites=true&w=majority&appName=Aegis-Maritime-System";
console.log('Connecting to:', uri.replace(/:(.*)@/, ':***@'));

async function test() {
  try {
    await mongoose.connect(uri, { serverSelectionTimeoutMS: 5000 });
    console.log('✅ Connected to MongoDB successfully.');
    
    // Check if there's any data in the 'boats' collection
    const db = mongoose.connection.db;
    const boats = await db.collection('boats').find({}).toArray();
    console.log(`Found ${boats.length} documents in 'boats' collection.`);
    if (boats.length > 0) {
      console.log('Sample boat:', boats[0]);
    }
  } catch (err) {
    console.error('❌ Connection error:', err);
  } finally {
    await mongoose.disconnect();
  }
}

test();
