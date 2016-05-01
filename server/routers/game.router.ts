import express = require('express');
import https = require('https');
import path = require('path');
import constants = require('../constants');
import GM = require('../game/gamesmanager');

let gameRouter = express.Router();
let gamesManager = GM.GamesManager.getInstance();

gameRouter.get('/', (req: express.Request, res: express.Response) => {
	let gameId = gamesManager.addGame();
	res.redirect("/game/" + gameId);
});

// Mounting the path with the angular code
gameRouter.use('/app', express.static(path.resolve(constants.CLIENT_ROOT, 'app')));

gameRouter.get('/:gameid', (req: express.Request, res: express.Response) => {
	res.sendFile(path.join(constants.PUBLIC_ROOT, '/views/index.html'));
});

module.exports = gameRouter;
