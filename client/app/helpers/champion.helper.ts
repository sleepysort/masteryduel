import {Component, OnInit, Input} from 'angular2/core';
import $ from 'jquery';
import {Dictionary, ChampionDto, GameState, Style, Wrapper} from '../interfaces/interfaces';
import {ChampionData, Location} from '../interfaces/data.interfaces';
import {LolApiService} from '../services/lolapi.service';
import {GameService} from '../services/game.service';

export class ChampionHelper {
	public static removeChampion(arr: ChampionData[], champ: ChampionData): boolean {
		for (let i = 0; i < arr.length; i++) {
			if (arr[i].uid === champ.uid) {
				arr.splice(i, 1);
				return true;
			}
		}
		return false;
	}
}
