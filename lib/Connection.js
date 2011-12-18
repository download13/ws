var util = require('util');
var EventEmitter = require('events').EventEmitter;
var Frame = require('./Frame').Frame;

var MSG_SIZE_LIMIT = 1048576; // Don't accept messages larger than 1MiB
var BUFFER_SIZE_LIMIT = 524288; // Don't allow the incoming assembly buffer to exceed 512KiB
var OUT_FRAME_LIMIT = 32768; // Fragment outgoing messages into 32KiB frames

function Connection(socket) {
	// Write in a way to open a message object and stream data through it to the client
	// Also, fragment large outgoing messages
	// Write a proper way for incoming data to be streamed to the application without a MSG_SIZE_LIMIT
	
	// Keep a data queue open for each frame, cut off if too much data keeps coming through
	// Need some way to ensure that a malicious user can't just keep spamming data
	
	this.dataLength = 0;
	this.dataBuffer = new Buffer(2048); // 4096 or 8192 if this is too small, need to write loggers that run during real use cases to find out
	this.frameStack = [];
	
	socket.setKeepAlive(true);
	socket.setTimeout(0);
	socket.setNoDelay(true); // Make this configurable and use it only when you are going to buffer outgoing data within the application
	this.socket = socket;
	socket.on('data', this._dataHandler.bind(this));
	socket.on('error', this._errorHandler.bind(this));
	
	this.fragmentQueue = [];
	this.fragmentType = 0;
	
	this.closeSent = false;
	this.closeReason = 0;
	this.closed = false;
	this.closeCodeBuffer = new Buffer(2);
	
	this.pingers = [];
	
	this.data = {}; // For use by applications that need to store per-connection data
}
util.inherits(Connection, EventEmitter);

Connection.prototype.sendText = function(data) {
	if(this.closed) return false;
	var frame = new Frame({
		opcode: Frame.TEXT,
		fin: true,
		data: data
	});
	try {
		this.socket.write(frame.toBuffer());
	} catch(e) {
		this.closed = true;
		return false;
	}
	return true;
}
Connection.prototype.sendBinary = function(data) {
	if(this.closed) return false;
	var frame = new Frame({
		opcode: Frame.BINARY,
		fin: true,
		data: data
	});
	try {
		this.socket.write(frame.toBuffer());
	} catch(e) {
		this.closed = true;
		return false;
	}
	return true;
}

Connection.prototype._errorHandler = function() {
	this.closed = true;
	this.emit('close', this, 0);
}

Connection.prototype._dataHandler = function(data) {
	// Write some loggers to show the average dataBuffer size for a Connection to see if there is a better way to do this
	var frame, needed = this.dataLength + data.length;
	if(needed > BUFFER_SIZE_LIMIT) {
		this.close(1008); // Violates our policy of not taking crap from malicious clients
		return;
	}
	
	// Build a weighting system here that adjusts the buffer size based on what the maximum packet size is (average max, find rare outlyers)
	/*
	if(this.dataBuffer.length > needed * 2) {
		
	}
	*/
	
	if(needed > this.dataBuffer.length) {
		var t = new Buffer(needed + 16);
		this.dataBuffer.copy(t, 0, 0, this.dataLength);
		this.dataBuffer = t;
	}
	data.copy(this.dataBuffer, this.dataLength);
	this.dataLength = needed;
	
	
	do {
		try {
			frame = new Frame(this.dataBuffer.slice(0, this.dataLength)); // Decode a frame
			this.frameStack.push(frame);
			if(frame.remainder == 0) { // There was no extra data, so we set the dataLength to 0
				this.dataLength = 0;
				break;
			}
			// There was extra data
			this.dataBuffer.copy(this.dataBuffer, 0, this.dataLength - frame.remainder, this.dataLength); // Push the remaining data to the front of the buffer
			this.dataLength = frame.remainder; // Save the remaining amount
		} catch(e) { // If there wasn't enough data to make another frame, then break from the loop
			break;
		}
	} while(this.dataLength > 1); // The smallest possible frame size is 2 bytes
	
	if(this.frameStack.length > 0) this._readFrames();
}

Connection.prototype._readFrames = function() {
	var frame, o;
	while(this.frameStack.length > 0) {
		frame = this.frameStack.shift();
		if(frame.opcode == Frame.TEXT || frame.opcode == Frame.BINARY) {
			if(frame.fin) { // This is the only frame in the message
				this.emit('message', this, frame.opcode, frame.data);
			} else {
				this.fragmentQueue.push(frame.data); // Store the frame as the first in the queue
				this.fragmentType = frame.opcode; // Store the type of the fragment queue
			}
		} else if(frame.opcode == Frame.CONTINUATION) {
			this.fragmentQueue.push(frame.data);
			if(frame.fin) { // This is the last frame in the message
				if(this.fragmentType == Frame.TEXT) {
					this.emit('message', this, frame.opcode, this.fragmentQueue.join('')); // String are easy
				} else if(this.fragmentType == Frame.BINARY) {
					var i, l = this.fragmentQueue.length, x = 0, buffer, total = 0;
					for(i = 0; i < l; i++) {
						total += this.fragmentQueue[i].length;
					}
					
					if(total > MSG_SIZE_LIMIT) {
						this.close(1009); // Message is too big
						return;
					}
					
					buffer = new Buffer(total);
					for(i = 0; i < l; i++) {
						x += this.fragmentQueue[i].copy(buffer, x);
					}
					this.emit('message', this, frame.opcode, buffer);
				}
			}
		} else if(frame.opcode == Frame.PING) {
			var f = new Frame({
				opcode: Frame.PONG,
				fin: true,
				data: frame.data
			});
			this.socket(f.toBuffer());
			//console.log('PING received, sending PONG');
		} else if(frame.opcode == Frame.PONG) {
			this.pingers.forEach(function(p) {
				clearTimeout(p[1]); // Cancel the fail timer
				p[0](true); // Tell the callback that the ping was successful
			});
		} else if(frame.opcode == Frame.CLOSE) {
			if(this.closeSent) this._finishClose(this.closeReason);
			else {
				var f = new Frame({ // Construct a close packet with the same payload that was sent
					opcode: Frame.CLOSE,
					fin: true,
					data: frame.data
				});
				this.socket.write(f.toBuffer()); // Send the close packet back to acknowledge the closing
				this.closeReason = frame.data.readUInt16BE(0); // Tell your close handler why the client wanted to close the connection
				this._finishClose();
			}
		}
	}
}

Connection.prototype.ping = function(cb) {
	if(this.closed) cb(false);
	var frame = new Frame({
		opcode: Frame.PING,
		fin: true
	});
	var timeout = setTimeout(cb.bind(null, false), 5000); // Wait 5 seconds to tell the callback that the verification failed
	this.pingers.push([cb, timeout]);
}

Connection.prototype.close = function(code) {
	if(this.closed) return;
	var data
	if(code == null) {
		data = null;
	} else {
		this.closeCodeBuffer.writeUInt16BE(code, 0);
		data = this.closeCodeBuffer;
	}
	
	var frame = new Frame({
		opcode: Frame.CLOSE,
		fin: true,
		data: data
	});
	
	this.socket.write(frame.toBuffer());
	
	this.closeReason = code;
	this.closeSent = true;
	
	var self = this;
	setTimeout(function() { // Ensure that the socket closes whether or not the peer agrees to the close
		if(!self.closed) self._finishClose();
	}, 1000);
}

Connection.prototype._finishClose = function() {
	this.socket.end();
	this.closed = true;
	this.emit('close', this, this.closeReason);
}

exports.Connection = Connection;