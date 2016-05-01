import express = require('express');
import https = require('https');
import constants = require('../constants');

let apiRouter = express.Router();

let dataCache = {};
// TODO: Use request instead of HTTPS
apiRouter.get('/full/*', (req: express.Request, res: express.Response) => {
	res.type('json');

	let query = '';
	for (let key in req.query) {
		query += key + '=' + req.query[key] + '&';
	}
	query += constants.LOL_API_KEY;

	https.get(constants.LOL_API_URL + req.path.substr(5) + '?' + query, (msg: any) => {
		let agg = "";
		msg.on('data', (data: any) => {
			agg += data.toString();
		}).on('end', () => {
			res.send(agg);
		}).on('error', (err: Error) => {
			res.send(err);
		});
	});
});

apiRouter.get('/champions', (req: express.Request, res: express.Response) => {
	res.type('json');
	if (dataCache['champions']) {
		res.send(dataCache['champions']);
		return;
	}

	let path = "/api/lol/static-data/na/v1.2/champion?";
	https.get(constants.LOL_API_URL + path + constants.LOL_API_KEY, (msg: any) => {
		let agg = "";
		msg.on('data', (data: any) => {
			agg += data.toString();
		}).on('end', () => {
			dataCache['champions'] = agg;
			res.send(agg);
		}).on('error', (err: Error) => {
			res.send(err);
		});
	});
});

module.exports = apiRouter;
