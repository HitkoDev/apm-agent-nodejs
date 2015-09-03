'use strict'

var http = require('http')
var util = require('util')
var events = require('events')
var OpbeatHttpClient = require('opbeat-http-client')
var ReleaseTracker = require('opbeat-release-tracker')
var config = require('./lib/config')
var parsers = require('./lib/parsers')
var request = require('./lib/request')
var connect = require('./lib/middleware/connect')

var userAgent = 'opbeat-nodejs/' + require('./package').version

var Client = function (opts) {
  if (!(this instanceof Client)) return new Client(opts)

  var client = this

  opts = config(opts)
  this.appId = opts.appId
  this.organizationId = opts.organizationId
  this.secretToken = opts.secretToken
  this.active = opts.active
  this.clientLogLevel = opts.clientLogLevel
  this.logger = opts.logger
  this.hostname = opts.hostname
  this.stackTraceLimit = opts.stackTraceLimit
  this.captureExceptions = opts.captureExceptions
  this.exceptionLogLevel = opts.exceptionLogLevel
  this.filter = opts.filter
  this._ff_captureFrame = opts._ff_captureFrame

  connect = connect.bind(this)
  this.middleware = { connect: connect, express: connect }

  if (!this.active) {
    this.logger.info('Opbeat logging is disabled for now')
    return
  } else if (!this.appId || !this.organizationId || !this.secretToken) {
    this.logger.info('[WARNING] Opbeat logging is disabled. To enable, specify organization id, app id and secret token')
    this.active = false
    return
  }

  this._httpClient = OpbeatHttpClient({
    appId: this.appId,
    organizationId: this.organizationId,
    secretToken: this.secretToken,
    userAgent: userAgent
  })

  Error.stackTraceLimit = this.stackTraceLimit
  if (this.captureExceptions) this.handleUncaughtExceptions()

  this.on('error', this._internalErrorLogger)
  this.on('logged', function (url) {
    client.logger.info('Opbeat logged error successfully at ' + url)
  })
}
util.inherits(Client, events.EventEmitter)

Client.prototype._internalErrorLogger = function (err) {
  this.logger.info('Could not notify Opbeat!')
  this.logger.error(err.stack)
}

Client.prototype.captureError = function (err, data, cb) {
  var client = this
  var captureTime = new Date()

  if (typeof data === 'function') {
    cb = data
    data = {}
  } else if (!data) {
    data = {}
  } else if (data.request instanceof http.IncomingMessage) {
    data.http = parsers.parseRequest(data.request)
  }
  delete data.request

  var level = this.exceptionLogLevel || 'error'
  level = level === 'warning' ? 'warn' : level

  if (!util.isError(err)) {
    var isMessage = true
    var customCulprit = 'culprit' in data
    parsers.parseMessage(err, data)
    this.logger[level](data.message)
    err = new Error(data.message)
  } else if (this._ff_captureFrame && !err.uncaught) {
    var captureFrameError = new Error()
  }

  parsers.parseError(err, data, function (data) {
    if (isMessage) {
      // Messages shouldn't have an exception and the algorithm for finding the
      // culprit might show the Opbeat client and we don't want that
      delete data.exception
      if (!customCulprit) delete data.culprit
      data.stacktrace.frames.shift()
    } else {
      client.logger[level](err.stack)
    }

    var done = function () {
      data.stacktrace.frames.reverse() // opbeat expects frames in reverse order
      data.machine = { hostname: client.hostname }
      data.extra = data.extra || {}
      data.extra.node = process.version
      data.timestamp = captureTime.toISOString()

      if (client.filter) data = client.filter(err, data)
      if (client.active) request.error(client, data, cb)
    }

    if (captureFrameError && !data.stacktrace.frames.some(function (frame) { return frame.in_app })) {
      // prepare to add a top frame to the stack trace specifying the location
      // where captureError was called from. This can make it easier to debug
      // async stack traces.
      parsers.parseError(captureFrameError, {}, function (result) {
        // ignore the first frame as it will be the opbeat module
        data.stacktrace.frames.unshift(result.stacktrace.frames[1])
        done()
      })
    } else {
      done()
    }
  })
}

// The optional callback will be called with the error object after the
// error have been logged to Opbeat. If no callback have been provided
// we will automatically terminate the process, so if you provide a
// callback you must remember to terminate the process manually.
Client.prototype.handleUncaughtExceptions = function (cb) {
  var client = this

  if (this._uncaughtExceptionListener) process.removeListener('uncaughtException', this._uncaughtExceptionListener)

  this._uncaughtExceptionListener = function (err) {
    client.logger.debug('Opbeat caught unhandled exception')

    // Since we exit the node-process we cannot guarantee that the
    // listeners will be called, so to ensure a uniform result,
    // we'll remove all event listeners if an uncaught exception is
    // found
    client.removeAllListeners()
    // But make sure emitted errors doesn't cause yet another uncaught
    // exception
    client.on('error', client._internalErrorLogger)

    err.uncaught = true

    var data = {
      level: client.exceptionLogLevel
    }
    client.captureError(err, data, function (opbeatErr, url) {
      if (opbeatErr) {
        client.logger.info('Could not notify Opbeat!')
        client.logger.error(opbeatErr.stack)
      } else {
        client.logger.info('Opbeat logged error successfully at ' + url)
      }
      cb ? cb(err, url) : process.exit(1)
    })
  }

  process.on('uncaughtException', this._uncaughtExceptionListener)
}

Client.prototype.trackRelease = function (data, cb) {
  if (data.path) {
    this.logger.warn('Detected use of deprecated path option to trackRelease function!')
    if (!data.cwd) data.cwd = data.path
  }
  if (!this._releaseTracker) this._releaseTracker = ReleaseTracker(this._httpClient)
  var client = this
  this._releaseTracker(data, function (err) {
    if (cb) cb(err)
    if (err) client.emit('error', err)
  })
}

Client.prototype.trackDeployment = Client.prototype.trackRelease

module.exports = Client
