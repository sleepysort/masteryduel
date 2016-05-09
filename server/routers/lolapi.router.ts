import express = require('express');
import https = require('https');
import constants = require('../constants');
import request = require('request');
import apikey = require('../apikey');

let apiRouter = express.Router();

let dataCache = {};

apiRouter.get('/full/*', (req: express.Request, res: express.Response) => {
	res.type('json');

	let query = '';
	for (let key in req.query) {
		query += key + '=' + req.query[key] + '&';
	}
	query += apikey.LOL_API_KEY;

	let options = {
		uri: constants.LOL_API_URL + req.path.substr(5) + '?' + query,
		json: true
	};

	request.get(options, (err, response, body) => {
		if (err) {
			res.send(response);
		} else {
			res.send(body);
		}
	});
});

apiRouter.get('/champions', (req: express.Request, res: express.Response) => {
	res.type('json');
	if (dataCache['champions']) {
		res.send(dataCache['champions']);
		return;
	}

	let path = "/api/lol/static-data/na/v1.2/champion?";
	let options = {
		uri: constants.LOL_API_URL + path + apikey.LOL_API_KEY,
		json: true
	};

	request.get(options, (err, response, body) => {
		if (err) {
			res.send(response);
		} else {
			res.send(body);
		}
	});
});

apiRouter.get('/champion/:id', (req: express.Request, res: express.Response) => {
	res.type('json');

	let path = "/api/lol/static-data/na/v1.2/champion/" + req.params["id"];
	let options = {
		uri: constants.LOL_API_URL + path + '?' + apikey.LOL_API_KEY,
		json: true
	};

	request.get(options, (err, response, body) => {
		if (err) {
			res.send(response);
		} else {
			res.send(body);
		}
	});
});

module.exports = apiRouter;
