import https = require('https');
import Promise = require('promise');
import request = require('request');
import constants = require('../constants');

export function getSummonerId(name: string): Promise.IThenable<number> {
	return new Promise((resolve, reject) => {
		let reqUrl = constants.LOL_API_URL + '/api/lol/na/v1.4/summoner/by-name/' + name + '?' + constants.LOL_API_KEY;
		let options = {
			uri: reqUrl,
			json: true
		}
		request.get(options, (err, response, body) => {
			if (err) {
				reject(response);
			} else if (!body[name] || !body[name].id) {
				reject(response);
			} else {
				resolve(body[name].id);
			}
		});
	});
}

export function getSummonerDeck(summonerId: number): Promise.IThenable<any[]> {
	return new Promise((resolve, reject) => {
		let reqUrl = constants.LOL_API_URL + '/championmastery/location/na1/player/' + summonerId + '/champions?' + constants.LOL_API_KEY;
		let options = {
			uri: reqUrl,
			json: true
		}
		request.get(options, (err, response, body) => {
			if (err) {
				reject(response);
			} else {
				resolve(body);
			}
		});
	});
}
