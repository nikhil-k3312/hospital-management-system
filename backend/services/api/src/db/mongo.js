const mongoose = require('mongoose');
const config = require('../config/config');
const logger = require('../utils/logger');

let bucket = null;

async function connectMongo(uri = config.mongodb.uri) {
  if (mongoose.connection.readyState === 0) {
    await mongoose.connect(uri, { serverSelectionTimeoutMS: 5000 });
    logger.info('MongoDB connected');
  }
  return mongoose.connection;
}

async function disconnectMongo() {
  bucket = null;
  if (mongoose.connection.readyState !== 0) {
    await mongoose.disconnect();
  }
}

/**
 * GridFS stores files larger than a normal document by splitting them into
 * 255 kB chunks (collections `uploads.files` and `uploads.chunks`). It ships
 * with the MongoDB driver, so no extra infrastructure is needed (decision D3).
 */
function getBucket() {
  if (!bucket) {
    bucket = new mongoose.mongo.GridFSBucket(mongoose.connection.db, { bucketName: 'uploads' });
  }
  return bucket;
}

module.exports = { connectMongo, disconnectMongo, getBucket };
