require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const WebSocket = require('ws');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const app = express();
const PORT = 5000;

// Middleware
app.use(cors());
app.use(express.json());

// --- MONGODB CONNECTION ---
// REPLACE THIS STRING WITH YOUR OWN ATLAS CONNECTION STRING
const MONGO_URI = process.env.MONGO_URI || 'mongodb+srv://admin:admin@cluster0.rv9hb.mongodb.net/Stock';

mongoose.connect(MONGO_URI)
  .then(() => console.log('✅ Connected to MongoDB'))
  .catch(err => console.error('❌ MongoDB Connection Error:', err));

// --- SCHEMAS ---
const userSchema = new mongoose.Schema({
  name: String,
  email: { type: String, unique: true, required: true },
  password: { type: String, required: true },
  balance: { type: Number, default: 10000 }, // Starting virtual cash
  portfolio: [{
    ticker: String,
    units: Number,
    avgCost: Number
  }]
});

const User = mongoose.model('User', userSchema);

// --- STOCK SIMULATION ---
const STOCKS = ['GOOG', 'TSLA', 'AMZN', 'META', 'NVDA'];
let currentPrices = {};
STOCKS.forEach(s => currentPrices[s] = (Math.random() * 500 + 100).toFixed(2));

// --- ROUTES ---

// 1. Register
app.post('/register', async (req, res) => {
  try {
    const { name, email, password } = req.body;
    const existing = await User.findOne({ email });
    if (existing) return res.status(400).json({ error: "User already exists" });

    const hashedPassword = await bcrypt.hash(password, 10);
    const newUser = new User({ name, email, password: hashedPassword, portfolio: [] });
    await newUser.save();
    
    res.json({ message: "Registration successful" });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 2. Login
app.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const user = await User.findOne({ email });
    if (!user) return res.status(400).json({ error: "User not found" });

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) return res.status(400).json({ error: "Invalid credentials" });

    const token = jwt.sign({ id: user._id }, 'secret_key');
    res.json({ token, user: { name: user.name, email: user.email, portfolio: user.portfolio, balance: user.balance } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 3. Get User Data (Refresh Portfolio)
app.get('/user/:email', async (req, res) => {
  try {
    const user = await User.findOne({ email: req.params.email });
    res.json(user);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 4. BUY Stock
app.post('/buy', async (req, res) => {
  try {
    const { email, ticker, units } = req.body;
    const price = parseFloat(currentPrices[ticker]);
    const cost = price * units;
    
    const user = await User.findOne({ email });
    
    // Check Funds (Optional feature)
    // if (user.balance < cost) return res.status(400).json({ error: "Insufficient funds" });

    const stockIndex = user.portfolio.findIndex(p => p.ticker === ticker);
    
    if (stockIndex > -1) {
      // Calculate new Weighted Average Price
      let oldUnits = user.portfolio[stockIndex].units;
      let oldCost = user.portfolio[stockIndex].avgCost;
      let newAvg = ((oldUnits * oldCost) + cost) / (oldUnits + units);
      
      user.portfolio[stockIndex].units += parseInt(units);
      user.portfolio[stockIndex].avgCost = newAvg;
    } else {
      user.portfolio.push({ ticker, units: parseInt(units), avgCost: price });
    }

    user.balance -= cost;
    await user.save();
    res.json(user);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 5. SELL Stock
app.post('/sell', async (req, res) => {
  try {
    const { email, ticker, units } = req.body;
    const price = parseFloat(currentPrices[ticker]);
    const revenue = price * units;
    
    const user = await User.findOne({ email });
    const stockIndex = user.portfolio.findIndex(p => p.ticker === ticker);
    
    if (stockIndex === -1 || user.portfolio[stockIndex].units < units) {
      return res.status(400).json({ error: "Not enough units to sell" });
    }

    user.portfolio[stockIndex].units -= parseInt(units);
    
    // Remove if 0 units
    if (user.portfolio[stockIndex].units === 0) {
      user.portfolio.splice(stockIndex, 1);
    }

    user.balance += revenue;
    await user.save();
    res.json(user);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// --- SERVER & WEBSOCKET ---
const server = app.listen(PORT, () => console.log(`🚀 Server on port ${PORT}`));

const wss = new WebSocket.Server({ server });

// Broadcast prices every second
setInterval(() => {
  STOCKS.forEach(stock => {
    const change = (Math.random() * 4) - 2; // Move up or down by max $2
    let newPrice = parseFloat(currentPrices[stock]) + change;
    if (newPrice < 10) newPrice = 10; // Floor price
    currentPrices[stock] = newPrice.toFixed(2);
  });

  const data = JSON.stringify({ type: 'PRICES', payload: currentPrices });
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) client.send(data);
  });
}, 1000);