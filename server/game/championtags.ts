import request = require('request');
import constants = require('../constants');
import Logger = require('../util/logger');
import I = require('./interfaces');

export class ChampionTags {
	private static tags: {[champId: number]: {primary: I.ChampionTag, secondary: I.ChampionTag} } = {};
	private static loaded: boolean = false;

	public static loadTags(): void {
		let reqUrl = "https://global.api.pvp.net/api/lol/static-data/na/v1.2/champion?champData=tags&" + constants.LOL_API_KEY;
		let options = {
			uri: reqUrl,
			json: true
		}
		request.get(options, (err, response, body) => {
			if (err) {
				throw new Error("Failed to load champion tags");
			} else {
				for (let key in body.data) {
					let champ = body.data[key];
					let tags: {primary: I.ChampionTag, secondary: I.ChampionTag} = {
						primary: I.ChampionTag[I.ChampionTag[champ.tags[0]]],
						secondary: I.ChampionTag[I.ChampionTag[champ.tags[1]]]
					};
					ChampionTags.tags[champ.id] = tags;
				}
			}
			ChampionTags.loaded = true;
			Logger.log(Logger.Tag.System, "Champion tags successfully loaded.");
		});
	}

	public static isReady(): boolean {
		return ChampionTags.loaded;
	}

	public static getTag(champId: number): {primary: I.ChampionTag, secondary: I.ChampionTag} {
		return ChampionTags.tags[champId];
	}
}
