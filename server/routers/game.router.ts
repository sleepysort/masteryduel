import express = require('express');
import https = require('https');
import path = require('path');
import constants = require('../constants');
import GM = require('../game/gamesmanager');

let gameRouter = express.Router();
let gamesManager = GM.GamesManager.getInstance();

gameRouter.get('/new', (req: express.Request, res: express.Response) => {
	let gameId = gamesManager.addGame();
	res.redirect("/game/" + gameId);
});

gameRouter.get('/quick', (req: express.Request, res: express.Response) => {
	let gameId = gamesManager.findOpenGame();
	if (gameId !== null) {
		res.redirect("/game/" + gameId);
	} else {
		res.redirect("/game/new");
	}

});

// Mounting the path with the angular code
gameRouter.use('/app', express.static(path.resolve(constants.CLIENT_ROOT, 'app')));

gameRouter.get('/:gameid', (req: express.Request, res: express.Response) => {
	if (gamesManager.hasGame(req.params['gameid'])) {
		res.sendFile(path.join(constants.PUBLIC_ROOT, '/views/game.html'));
	} else {
		res.sendStatus(404);
	}
});

module.exports = gameRouter;
