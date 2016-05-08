import {Component, OnInit} from 'angular2/core';
import {Dictionary, ChampionDto, GameState, Style, Wrapper} from '../interfaces/interfaces';
import * as I from '../interfaces/data.interfaces';
import {LolApiService} from '../services/lolapi.service';
import {GameService} from '../services/game.service';
import {ChampionPositionerComponent} from './championpositioner.component';
import $ from 'jquery';

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
	public enemyNexusHealth: Wrapper<number>;

	constructor(private game: GameService, private lolApi: LolApiService) { }

	public ngOnInit(): void {
		this.gameState = this.game.getGameState();
		this.playerNexusHealth = this.game.getPlayerNexusHealth()
		this.enemyNexusHealth = this.game.getEnemyNexusHealth()
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

	public onMessageLogger(event: KeyboardEvent): void {
		if (event.keyCode === 13) {  // Enter
			this.game.send('gamechat', {
				playerId: this.game.getPlayerId(),
				text: $('.message-logger-input').val()
			});
			$('.message-logger-input').val('');
		}
	}
}
