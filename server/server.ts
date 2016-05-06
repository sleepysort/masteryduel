import http = require('http');
import express = require('express');
import path = require('path');
import constants = require('./constants');
import GM = require('./game/gamesmanager');
import Logger = require('./util/logger');
import I = require('./game/interfaces');

let gameRouter = require('./routers/game.router');
let lolapiRouter = require('./routers/lolapi.router');
let port: number = process.env.PORT || 8000;
let app = express();

let server = http.createServer(app);

import socketio = require('socket.io');
let io = socketio(server);
let gamesManager = GM.GamesManager.getInstance();

/************************************************
 * Setup statics routes
 */
// Path to npm packages
app.use('/lib', express.static(path.resolve(constants.PROJ_ROOT, 'node_modules')));

// Path to public files
app.use('/public', express.static(constants.PUBLIC_ROOT))


/************************************************
 * Set up routers
 */
app.use('/game', gameRouter);
app.use('/lolapi', lolapiRouter);

/************************************************
 * Route to index
 */
app.get('/', (req: express.Request, res: express.Response) => {
    res.sendFile(path.join(constants.PUBLIC_ROOT, '/views/index.html'));
});

io.on('connection', (sock: SocketIO.Socket) => {
    // TODO: race condition
    sock.once('gamejoin', (msg: I.DataGameJoin) => {
        Logger.log(Logger.Tag.Network, 'Attempting to join game ' + msg.gameId + '.');
        let currGame = gamesManager.getGame(msg.gameId);

        if (!currGame) {
            Logger.log(Logger.Tag.Network, 'Failed to join game ' + msg.gameId + '. Game does not exist.');
            sock.emit('gamejoin-ack', {
                success: false,
                reason: 'This game does not exist.'
            });
            sock.disconnect();
            return;
        }

        try {
            currGame.addPlayer(sock);
        } catch (err) {
            Logger.log(Logger.Tag.Network, 'Failed to join game ' + msg.gameId + '. Game is already full.');
            sock.emit('gamejoin-ack', {
                success: false,
                reason: 'This game already has two players.'
            });
            sock.disconnect();
        }
    });
});

server.listen(port, () => {
    let host = server.address().address;
    let port = server.address().port;
    Logger.log(Logger.Tag.System, 'Server started on ' + host + ':' + port);
});
