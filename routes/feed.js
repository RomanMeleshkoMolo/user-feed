const express = require('express');
const router = express.Router();

const { auth } = require('../middlewares/auth');
const {
  getFeed,
  getUserProfile,
  likeUser,
  passUser,
  getMatches,
} = require('../controllers/feedController');

// Все эндпоинты защищены авторизацией
// GET /feed - получить ленту пользователей (с пагинацией)
router.get('/feed', auth({ optional: false }), getFeed);

// GET /feed/matches - получить список матчей
router.get('/feed/matches', auth({ optional: false }), getMatches);

// GET /feed/:userId - получить профиль конкретного пользователя
router.get('/feed/:userId', auth({ optional: false }), getUserProfile);

// POST /feed/:userId/like - лайкнуть пользователя
router.post('/feed/:userId/like', auth({ optional: false }), likeUser);

// POST /feed/:userId/pass - пропустить пользователя
router.post('/feed/:userId/pass', auth({ optional: false }), passUser);

module.exports = router;