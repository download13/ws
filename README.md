ws
==

### To use:
```javascript
var ws = require('ws');
var wsserver = ws.createServer(function(connection) {
	// connection.data is available for holding any data you with to associate with a certain WebSocket connection
	connection.on('message', function(type, message) {
		// type is the opcode of the message. 1 for text, 2 for binary, etc
		// message is a string if type is 1, or a buffer object if type is 2
	});
});
```

### For a standalone websocket server:
```javascript
wsserver.listen();
```

### For a server attached to an existing HTTP Server (node, express, etc):
```javascript
var httpserver = require('http').createServer(function() {/* whatever */});
wsserver.listen(httpserver);
```