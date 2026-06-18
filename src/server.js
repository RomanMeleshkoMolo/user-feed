const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const helmet = require('helmet');
const { sanitize } = require('express-mongo-sanitize');
require('dotenv').config();

require('./db');
require('./likesDb');
require('./redis');
const cacheWarmer = require('./cacheWarmer');

// Connect routers
const feed = require('../routes/feed');

const app = express();
const PORT = process.env.PORT || 5000;

app.use(helmet());
app.use(cors({ origin: '*' }));
app.use(bodyParser.json({ limit: '1mb' }));
app.use(bodyParser.urlencoded({ extended: true, limit: '1mb' }));
app.use((req, res, next) => {
  if (req.body) sanitize(req.body);
  if (req.params) sanitize(req.params);
  if (req.query) sanitize(req.query);
  next();
});

app.get('/health', (req, res) => res.json({ status: 'ok' }));

// Use routes
app.use(feed);

app.listen(PORT, '0.0.0.0', () => {
  console.log(`User Feed Service is running on http://localhost:${PORT}`);
  cacheWarmer.start();
});