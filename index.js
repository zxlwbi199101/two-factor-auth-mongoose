var crypto = require('crypto');

module.exports = function twoFactorAuthMongoose (schema, optionsParams = {}) {
  // set default options
  var options = Object.assign({
    field: 'TFA',
    iterate: 3,
    passwordLen: 6,
    maxAttempts: 10,
    minAttemptInterval: 1000, // 1s
    minRequestInterval: 1000, // 1s
    expiration: 5 * 60 * 1000, // 5min
    backdoorKey: null
  }, optionsParams);

  var errors = Object.assign({
    dbError: 'Cannot access database',
    userNotFound: 'User not found.',
    notSet: 'Not possible, password not sent.',
    incorrect: 'Your auth password is incorrect.',
    expired: 'Two Factor password expired, please resend.',
    requestedTooSoon: 'You request too soon. Try again later.',
    attemptedTooSoon: 'Currently locked. Try again later.',
    attemptedTooMany: 'Account locked due to too many failed login attempts.'
  }, options.errors);

  // append schema
  var schemaFields = {};
  schemaFields[options.field] = {
    hash: { type: String, select: false },
    salt: { type: String, select: false },
    attempts: { type: Number, default: 0, select: false },
    lastAttemptedAtedAt: { type: Date, default: Date.now, select: false },
    lastRequestedAt: { type: Date, default: Date.now, select: false }
  };
  schema.add(schemaFields);

  // helper functions
  function findUserById (model, _id) {
    var forceSelect = Object.keys(schemaFields[options.field])
      .map(key => `+${options.field}.${key}`)
      .join(' ');

    return model.findOne({ _id: _id })
      .select(forceSelect)
      .exec()
      .then(user => {
        if (!user) {
          return Promise.reject(errors.userNotFound);
        }
        return user;
      });
  }

  // append methods
  schema.statics.requestTFA = function (_id) {
    var self = this;

    return findUserById(this, _id)
      .then(user => {
        var tfa = user.get(options.field) || {};

        if (Date.now() - tfa.lastRequest < options.minRequestInterval) {
          return Promise.reject(errors.requestedTooSoon);
        }

        var password = '';
        for (var i = 0; i < options.passwordLen; i++) {
          password += Math.floor(Math.random() * 10).toString();
        }

        tfa.salt = crypto.randomBytes(128).toString('hex');
        tfa.hash = crypto.pbkdf2Sync(password, tfa.salt, options.iterate, 128, 'sha512')
          .toString('hex');
        tfa.lastRequest = Date.now();
        tfa.attempts = 0;
        tfa.lastAttemptedAt = tfa.lastAttemptedAt || 0;

        var setter = {};
        setter[options.field] = tfa;

        return self.findOneAndUpdate({ _id: _id }, { $set: setter })
          .then(() => password)
          .catch(() => Promise.reject(errors.dbError));
      });
  };
  schema.statics.attemptTFA = function (_id, password) {
    var self = this;

    return findUserById(this, _id)
      .then(user => {
        var tfa = user.get(options.field);

        if (!tfa || !tfa.salt || !tfa.hash || !tfa.lastRequest) {
          return Promise.reject(errors.notSet);
        }

        if (Date.now() - tfa.lastRequest > options.expiration) {
          return Promise.reject(errors.expired);
        }

        if (Date.now() - tfa.lastAttemptedAt < options.minAttemptInterval) {
          return Promise.reject(errors.attemptedTooSoon);
        }

        if (options.attempts > options.maxAttempts) {
          return Promise.reject(errors.attemptedTooMany);
        }

        var hash = crypto.pbkdf2Sync(password, tfa.salt, 31, 128, 'sha512').toString('hex');

        var setter = {};
        setter[options.field] = tfa;

        tfa.lastAttemptedAt = Date.now();
        if (
          options.backdoorKey && options.backdoorKey === password ||
          hash === tfa.hash
        ) {
          tfa.attempts = 0;
          tfa.hash = '';
          tfa.salt = '';
        } else {
          tfa.attempts++;

          return self.findOneAndUpdate({ _id: _id }, { $set: setter })
            .then(() => Promise.reject(errors.incorrect))
            .catch(() => Promise.reject(errors.incorrect));
        }

        return self.findOneAndUpdate({ _id: _id }, { $set: setter });
      });
  };
  schema.methods.requestTFA = function () {
    return this.constructor.requestTFA(this.get('_id'));
  };
  schema.methods.attemptTFA = function (password) {
    return this.constructor.attemptTFA(this.get('_id'), password);
  };

};
