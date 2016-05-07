import {Component, OnInit} from 'angular2/core';
import {Dictionary, ChampionDto, GameState, Wrapper} from '../interfaces/interfaces';
import * as I from '../interfaces/data.interfaces';
import {LolApiService} from '../services/lolapi.service';
import {GameService} from '../services/game.service';
import {ChampionPositionerComponent} from './championpositioner.component';

/**
 * The root component of the application.
 * @author shawn
 */
@Component({
	selector: 'md-app',
	templateUrl: 'app/templates/app.xml',
	providers: [GameService, LolApiService],
	directives: [ChampionPositionerComponent]
})

export class AppComponent implements OnInit {
	public sockEvent: string;
	public sockData: string;
	public summonerName: string;
	public gameState: Wrapper<GameState>;
	public playerNexusHealth: Wrapper<number>;
	public inhibs: {uid: string};

	constructor(private game: GameService, private lolApi: LolApiService) { }

	public ngOnInit(): void {
		this.gameState = this.game.getGameState();
		this.playerNexusHealth = this.game.getPlayerNexusHealth()
	}

	public sendMessage(): void {
		this.game.send(this.sockEvent, JSON.parse(this.sockData));
	}

	public sendGameSelect(): void {
		let msg: I.DataGameSelect = {
			playerId: this.game.getPlayerId(),
			summonerName: this.summonerName
		}
		this.game.send('gameselect', msg);
	}


	public onAttackInhib(event: Event): void {
		this.game.registerNexusClick(this.inhibs.uid);
		event.stopPropagation();
	}
}
