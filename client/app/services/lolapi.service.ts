import {Injectable} from 'angular2/core';
import {ChampionDto, Dictionary} from '../interfaces/interfaces';
import {SERVER_HOSTNAME} from './hostname';

const DATA_DRAGON_URL = "http://ddragon.leagueoflegends.com/cdn/img/champion/loading/";
const DATA_DRAGON_IMG_EXTENSION = "_0.jpg";

@Injectable()
export class LolApiService {
	private championCache: { [id: number]: ChampionDto };

	constructor() {
		this.championCache = {};
		this.getChampions().then((dict: Dictionary<ChampionDto>) => {
			for (let k in dict) {
				this.championCache[dict[k].id] = dict[k];
			}
		});
	}

	public getChampions(): Promise<Dictionary<ChampionDto>> {
		return new Promise<Dictionary<ChampionDto>>((resolve, reject) => {
			$.getJSON(SERVER_HOSTNAME + '/lolapi/champions', (res: any) => {
				if (!('data' in res)) {
					reject(res.status.status_code);
				}
				resolve(res['data']);
			});
		});
	}

	public getChampionDtoById(champId: number) {
		if (!this.championCache) {
			return null;
		}
		return this.championCache[champId];
	}

	public getChampionImageUrl(champId: number): string {
		if (!this.championCache) {
			return null;
		}
		return DATA_DRAGON_URL + this.championCache[champId].key + DATA_DRAGON_IMG_EXTENSION;
	}

	public getSummonerIconUrl(iconId: number): string {
		return 'http://ddragon.leagueoflegends.com/cdn/6.9.1/img/profileicon/' + iconId + '.png';
	}
}
