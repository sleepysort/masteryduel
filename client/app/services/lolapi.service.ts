import {Injectable} from 'angular2/core';
import {ChampionDto, Dictionary} from '../../interfaces/interfaces';

@Injectable()
export class LolApiService {

	public getChampions(): Promise<Dictionary<ChampionDto>> {
		return new Promise<Dictionary<ChampionDto>>((resolve, reject) => {
			$.getJSON('http://localhost:8000/lolapi/champions', (res: any) => {
				if (!('data' in res)) {
					reject(res.status.status_code);
				}

				resolve(res['data']);
			});
		});
	}
}
