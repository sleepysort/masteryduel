import {Component, OnInit, Input} from 'angular2/core';
import {Dictionary, ChampionDto, GameState, Style, Wrapper} from '../interfaces/interfaces';
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
	@Input()
	public summonerName: string;

	public sockEvent: string;
	public sockData: string;
	public gameState: Wrapper<GameState>;
	public playerNexusHealth: Wrapper<number>;
	public enemyNexusHealth: Wrapper<number>;
	public isPlayerTurn: Wrapper<number>;
	public moveCount: Wrapper<number>;
	public timeleft: Wrapper<number>;
	public loadingMsg: Wrapper<string>;
	public gameLink: string;
	public isVictor: Wrapper<boolean>;
	public playerId: string;

	constructor(private game: GameService, private lolApi: LolApiService) { }

	public ngOnInit(): void {
		this.gameState = this.game.getGameState();
		this.playerNexusHealth = this.game.getPlayerNexusHealth();
		this.enemyNexusHealth = this.game.getEnemyNexusHealth();
		this.isPlayerTurn = this.game.getIsPlayerTurn();
		this.moveCount = this.game.getCurrentTurnMovesLeft();
		this.timeleft = this.game.getTimeLeft();
		this.loadingMsg = this.game.getLoadingMessage();
		this.gameLink = window.location.href;
		this.isVictor = this.game.getIsVictor();
		this.playerId = this.game.getPlayerId();
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

	public onPassButtonClick(event: Event) {
		if (this.isPlayerTurn.value === 1) {
			this.game.send('gamepass', {playerId: this.game.getPlayerId()});
		}
	}

	public getPlayerIconUrl(): string {
		return this.lolApi.getSummonerIconUrl(this.game.getPlayerIconNumber());
	}

	public getEnemyIconUrl(): string {
		return this.lolApi.getSummonerIconUrl(this.game.getEnemyIconNumber());
	}

	public getPlayerSummonerName(): string {
		return this.game.getPlayerSummonerName();
	}

	public getEnemySummonerName(): string {
		return this.game.getEnemySummonerName();
	}

	public onSummonerSubmit(event: KeyboardEvent): void {
		if (event.keyCode === 13) {  // Enter
			this.sendGameSelect();
		}
	}
}
