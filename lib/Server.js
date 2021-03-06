var crypto = require('crypto');
var util = require('util');
var EventEmitter = require('events').EventEmitter;
var Connection = require('./Connection').Connection;

var GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function createServer(handler, config) {
	return new Server(handler, config);
}

function Server(handler, config) {
	if(typeof handler == 'function') {
		this.on('connection', handler);
	} else if(handler) {
		config = handler;
	}
	config = config || {};
	
	this.noDelay = Boolean(config.noDelay);
	
	this.connections = [];
	this.selfServing = false;
	this._boundUpgradeHandler = this._upgradeHandler.bind(this);
	this._boundCloseHandler = this._closeHandler.bind(this);
}
util.inherits(Server, EventEmitter);

Server.prototype.listen = function(server) {
	var port;
	if(server == undefined) server = 80;
	if(typeof server == 'number') {
		port = server;
		server = require('http').createServer();
		server.listen(port);
		this.selfServing = true;
	} else port = 80;
	
	server.on('upgrade', this._boundUpgradeHandler);
	this.server = server;
}

Server.prototype.broadcastText = function(data) {
	for(var i = 0, l = this.connections.length; i < l; i++) {
		this.connections[i].sendText(data);
	}
}

Server.prototype.broadcastBinary = function(data) {
	for(var i = 0, l = this.connections.length; i < l; i++) {
		this.connections[i].sendBinary(data);
	}
}

Server.prototype._upgradeHandler = function(req, socket) {
	socket.setNoDelay(this.noDelay);
	
	// We probably don't need to account for head, but keep it in mind if something goes wrong here
	var protocols;
	var version = req.headers['sec-websocket-version'];
	var key = req.headers['sec-websocket-key'];
	var origin = req.headers['origin'] || req.headers['sec-websocket-origin']; // Support older browsers as well
	
	// Remove these for now until subprotocols are implemented
	//var plist = req.headers["sec-websocket-protocol"];
	//if(plist) protocols = plist.toLowerCase().split(/,\s*/);
    //else protocols = [];
	// Same with this
	//var extensions = req.headers["sec-websocket-extensions"];
	
	// version should be 13, but don't enforce that right now
	// origin should be filterable or matchable
	// 
	
	/*
	//check this and 
	if(request.headers['x-forwarded-for'])
	{
        this.remoteAddress = request.headers['x-forwarded-for'].split(', ')[0];
    }
	*/
	
	// Let send an event to the application so they can decide if this connection should be accepted
	
	// Find something to activate this later
	/*
	if(!allowconnection)
	{
		socket.write("HTTP/1.1 501 Not Implemented\r\nConnection: close\r\nSec-WebSocket-Accept: "+key+"\r\n\r\n");
		return;
	}
	*/
	
	var hash = crypto.createHash('sha1');
	hash.update(key + GUID);
	key = Buffer(hash.digest(), 'binary').toString('base64');
	var response = 'HTTP/1.1 101 Switching Protocols\r\nUpgrade: WebSocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + key + '\r\n\r\n';
	socket.write(response);
	
	var c = new Connection(socket);
	this.connections.push(c);
	c.once('close', this._boundCloseHandler);
	
	this.emit('connection', req, c); // Fire a `connection` event with a reference to the connection object so the application can add listeners
	// Also send the request object so we can get cookies and session information
}

Server.prototype._closeHandler = function(c) {
	var i = this.connections.indexOf(c);
	if(i !== -1) this.connections.splice(i, 1);
}

Server.prototype.close = function() {
	this.server.removeListener('upgrade', this._boundUpgradeHandler);
	if(this.selfServing) this.server.close();
	this.connections.forEach(function(c) {
		c.close(1001); // The server is "going away"
	});
	this.emit('close');
}

exports.Server = Server;
exports.createServer = createServer;