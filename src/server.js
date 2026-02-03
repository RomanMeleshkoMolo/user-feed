const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
require('dotenv').config();

// Connect routers
const feed = require('../routes/feed');

const app = express();
const PORT = process.env.PORT || 5000;

app.use(cors({ origin: '*' }));
app.use(bodyParser.json());

// Use routes
app.use(feed);

app.listen(PORT, '0.0.0.0', () => {
  console.log(`User Feed Service is running on http://localhost:${PORT}`);
});