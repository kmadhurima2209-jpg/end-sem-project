// MongoDB Atlas data layer (replaces the old data/db.json file).
// Collections: users, bookings, complaints, messages  (database name comes from MONGODB_DB)
const bcrypt = require("bcryptjs");
const { MongoClient } = require("mongodb");
const config = require("./config");

const NO_ID = { projection: { _id: 0 } };  // never send Mongo's internal _id to the frontend

let client, users, bookings, complaints, messages;

// ---------- connection ----------
async function doConnect() {
  if (!config.MONGODB_URI) {
    throw new Error("MONGODB_URI is not set. Create a .env file (see .env.example) with your Atlas connection string.");
  }
  client = new MongoClient(config.MONGODB_URI, { serverSelectionTimeoutMS: 10000 });
  await client.connect();
  const db = client.db(config.MONGODB_DB);
  users = db.collection("users");
  bookings = db.collection("bookings");
  complaints = db.collection("complaints");
  messages = db.collection("messages");
  await messages.createIndex({ bookingId: 1 });
  await complaints.createIndex({ id: 1 }, { unique: true });

  await users.createIndex({ email: 1 }, { unique: true });                 // one account per email
  await bookings.createIndex({ id: 1 }, { unique: true });                 // unique booking id
  await bookings.createIndex({ email: 1 });                                // fast "my bookings"

  // Default admin account (same as the original project); created only if missing
  await users.updateOne(
    { email: "admin@homeservices.com" },
    { $setOnInsert: { name: "Administrator", email: "admin@homeservices.com", password: bcrypt.hashSync("admin123", 12), role: "admin" } },
    { upsert: true }
  );
}
// Safe to call on every request: connects once and reuses the connection (important on Vercel)
let connecting = null;
function connect() {
  if (!connecting) connecting = doConnect().catch(e => { connecting = null; throw e; });
  return connecting;
}
async function close() { if (client) await client.close(); connecting = null; }

// ---------- users ----------
const findUserByEmail = email => users.findOne({ email }, NO_ID);
const getAllUsers = () => users.find({}, NO_ID).sort({ _id: 1 }).toArray();
async function createUser(user) {
  try { await users.insertOne({ ...user }); return true; }
  catch (e) { if (e && e.code === 11000) return false; throw e; } // duplicate email
}

// ---------- bookings ----------
async function createBooking(fields) {
  let id = Date.now();
  for (let tries = 0; tries < 20; tries++, id++) {
    const booking = { id, ...fields, status: "Pending", paid: false };
    try { await bookings.insertOne({ ...booking }); return booking; }
    catch (e) { if (!e || e.code !== 11000) throw e; } // id taken -> try next id
  }
  throw new Error("Could not create booking");
}
const getBookingsByEmail = email => bookings.find({ email }, NO_ID).sort({ _id: 1 }).toArray();
const getAllBookings = () => bookings.find({}, NO_ID).sort({ _id: 1 }).toArray();
async function updateBookingStatus(id, status) {
  const r = await bookings.findOneAndUpdate({ id }, { $set: { status } }, { returnDocument: "after", projection: { _id: 0 } });
  return r && r.value !== undefined ? r.value : r; // supports driver v5 ({value}) and v6 (document)
}

const updateUser = (email, f) => users.updateOne({ email }, { $set: f });
const getBooking = id => bookings.findOne({ id }, NO_ID);
const getBookingsByProvider = email => bookings.find({ providerEmail: email }, NO_ID).sort({ _id: 1 }).toArray();
async function updateBooking(id, f) {
  const r = await bookings.findOneAndUpdate({ id }, { $set: f }, { returnDocument: "after", projection: { _id: 0 } });
  return r && r.value !== undefined ? r.value : r;
}
async function createComplaint(fields) {
  let id = Date.now();
  for (let tries = 0; tries < 20; tries++, id++) {
    const c = { id, ...fields, status: "Open" };
    try { await complaints.insertOne({ ...c }); return c; } catch (e) { if (!e || e.code !== 11000) throw e; }
  }
  throw new Error("Could not create complaint");
}
const getComplaints = () => complaints.find({}, NO_ID).sort({ _id: 1 }).toArray();
async function resolveComplaint(id) {
  const r = await complaints.findOneAndUpdate({ id }, { $set: { status: "Resolved" } }, { returnDocument: "after", projection: { _id: 0 } });
  return r && r.value !== undefined ? r.value : r;
}

const createMessage = async m => { const doc = { ...m, at: new Date().toISOString() }; await messages.insertOne({ ...doc }); return doc; };
const getMessages = bookingId => messages.find({ bookingId }, NO_ID).sort({ _id: 1 }).toArray();
// Used by /api/health to prove the connection works
async function ping() {
  await connect();
  await client.db(config.MONGODB_DB).command({ ping: 1 });
}
module.exports = {
  ping,
  createMessage, getMessages,
  updateUser, getBooking, getBookingsByProvider, updateBooking, createComplaint, getComplaints, resolveComplaint,
  connect, close,
  findUserByEmail, getAllUsers, createUser,
  createBooking, getBookingsByEmail, getAllBookings, updateBookingStatus
};
