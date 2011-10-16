var mask_buffer = new Buffer(4);

function Frame(data) {
	if(data instanceof Buffer) {
		this.fromBuffer(data);
	} else {
		this.fin = data.fin;
		this.opcode = data.opcode;
		
		if(data.data) {
			this.data = data.data;
			if(this.data instanceof Buffer) this.len = this.data.length;
			else this.len = Buffer.byteLength(this.data);
		} else this.len = 0;
		
		if(data.mask != undefined) {
			this.masked = true;
			this.mask = data.mask;
		}
	}
}
Frame.CONTINUATION = 0;
Frame.TEXT = 1;
Frame.BINARY = 2;
Frame.CLOSE = 8;
Frame.PING = 9;
Frame.PONG = 10;

Frame.prototype.toBuffer = function() {
	var lenField, i = 2;
	var totalLength = 2 + this.len;
	if(this.len > 65535) {
		totalLength += 8;
		lenField = 127;
	} else if(this.len > 125) {
		totalLength += 2;
		lenField = 126;
	} else lenField = this.len;
	
	if(this.masked) totalLength += 4;
	
	var buffer = new Buffer(totalLength);
	buffer[0] = (this.fin * 128) | this.opcode;
	buffer[1] = (this.masked * 128) | lenField;
	
	if(lenField == 126) { // Length is a 16 bit value
		buffer.writeUInt16BE(this.len, i);
		i += 2;
	} else if(lenField == 127) { // Length is a 64 bit value
		buffer.writeUInt32BE(this.len >> 32, i);
		buffer.writeUInt32BE(this.len & 32, i += 4);
		i += 4;
	}
	
	if(this.masked) {
		buffer.writeUInt32BE(this.mask, i);
		i += 4;
	}
	
	if(this.data) {
		if(this.data instanceof Buffer) this.data.copy(buffer, i);
		else buffer.write(this.data, i);
		i += this.len;
	}
	
	return buffer;
}

Frame.prototype.fromBuffer = function(data) {
	var x = 0, b = data[x++], t;
	this.fin = Boolean(b & 128);
	this.opcode = b & 15;
	b = data[x++];
	this.masked = Boolean(b & 128);
	this.len = b & 127;
	
	if(this.len == 126) {
		this.len = data.readUInt16BE(x);
		x += 2;
	} else if(this.len == 127) {
		this.len = data.readUInt32BE(x) << 32;
		this.len |= data.readUInt32BE(x += 4);
		x += 4;
	}
	
	if(this.masked) {
		//this.mask = new Buffer(4);
		//data.copy(this.mask, 0, x, x += 4);
		var mask = data.slice(x, x += 4); // We're only going to use it for a moment, so don't bother allocating a new Buffer
	}
	
	if(this.len > data.length - x) { // There isn't enough data to finish the frame
		throw "Incomplete frame";
	}
	
	// Extension code will go here
	
	t = x + this.len;
	this.remainder = data.length - t;
	
	data = data.slice(x, t); // Change to only reference the applicaton data
	if(this.masked) { // De-mask the data from the client
		for(var i = 0, l = data.length; i < l; i++) {
			data[i] = data[i] ^ mask[i % 4];
		}
		this.masked = false;
	}
	
	if(this.opcode == Frame.TEXT) {
		this.data = data.toString("utf8");
	} else {
		this.data = new Buffer(this.len);
		data.copy(this.data);
	}
}

exports.Frame = Frame;