import Promise = require('promise');
import request = require('request');
import constants = require('../constants');
import apikey = require('../apikey');

export function getSummonerId(name: string): Promise.IThenable<{summonerId: number, icon: number}> {
	return new Promise((resolve, reject) => {
		name = name.replace(/ /g, '');
		let reqUrl = constants.LOL_API_URL + '/api/lol/na/v1.4/summoner/by-name/' + name + '?' + apikey.LOL_API_KEY;
		let options = {
			uri: reqUrl,
			json: true
		}
		request.get(options, (err, response, body) => {
			if (err) {
				reject("Could not connect to League of Legends server.");
			} else if (!body[name] || !body[name].id) {
				reject("Could not find summoner with the given name.");
			} else {
				resolve({
					summonerId: body[name].id,
					summonerName: body[name].name,
					icon: body[name].profileIconId
				});
			}
		});
	});
}

export function getSummonerDeck(data: {summonerId: number, summonerName: string, icon: number}): Promise.IThenable<{icon: number, body: any[]}> {
	return new Promise((resolve, reject) => {
		let reqUrl = constants.LOL_API_URL + '/championmastery/location/na1/player/' + data.summonerId + '/champions?' + apikey.LOL_API_KEY;
		let options = {
			uri: reqUrl,
			json: true
		}
		request.get(options, (err, response, body) => {
			if (err) {
				reject(response);
			} else {
				resolve({
					body: body,
					name: data.summonerName,
					icon: data.icon
				});
			}
		});
	});
}
