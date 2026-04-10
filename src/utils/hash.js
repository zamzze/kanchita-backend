const bcrypt = require('bcryptjs');

const SALT_ROUNDS = 12;

const hashPassword = (plainText) =>
  bcrypt.hash(plainText, SALT_ROUNDS);

const comparePassword = (plainText, hash) =>
  bcrypt.compare(plainText, hash);

module.exports = { hashPassword, comparePassword };