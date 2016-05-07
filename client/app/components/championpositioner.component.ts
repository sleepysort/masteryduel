import {Component, OnInit, Input} from 'angular2/core';
import $ from 'jquery';
import {Dictionary, ChampionDto, GameState, Style, Wrapper} from '../interfaces/interfaces';
import {ChampionData, Location} from '../interfaces/data.interfaces';
import {LolApiService} from '../services/lolapi.service';
import {GameService} from '../services/game.service';
import {ChampionComponent} from './champion.component';

/**
 * The root component of the application.
 * @author shawn
 */
@Component({
	selector: 'md-championpositioner',
	templateUrl: 'app/templates/championpositioner.xml',
	directives: [ChampionComponent]
})

export class ChampionPositionerComponent implements OnInit {
	public topLaneAllies: ChampionData[];
	public midLaneAllies: ChampionData[];
	public botLaneAllies: ChampionData[];
	public topLaneEnemies: ChampionData[];
	public midLaneEnemies: ChampionData[];
	public botLaneEnemies: ChampionData[];
	public topLaneStyles: Style;
	public midLaneStyles: Style;
	public botLaneStyles: Style;
	public enemyInhibs: Style[];

	public hand: ChampionData[];

	public isDrawerOpen: boolean;

	constructor(private game: GameService, private lolapi: LolApiService) {
	}

	public ngOnInit(): void {
		this.hand = this.game.getHand();
		this.topLaneAllies = this.game.getTopLaneAllies();
		this.midLaneAllies = this.game.getMidLaneAllies();
		this.botLaneAllies = this.game.getBotLaneAllies();
		this.topLaneEnemies = this.game.getTopLaneEnemies();
		this.midLaneEnemies = this.game.getMidLaneEnemies();
		this.botLaneEnemies = this.game.getBotLaneEnemies();
		this.topLaneStyles = this.game.getLaneStyles(0);
		this.midLaneStyles = this.game.getLaneStyles(1);
		this.botLaneStyles = this.game.getLaneStyles(2);
		this.enemyInhibs = this.game.getEnemyInhibStyles();

		this.isDrawerOpen = true;
	}

	public onTopLaneClicked() {
		if (this.topLaneStyles.isActive) {
			this.game.registerLaneClick("LaneTop");
		}
	}

	public onMidLaneClicked() {
		if (this.midLaneStyles.isActive) {
			this.game.registerLaneClick("LaneMid");
		}
	}

	public onBotLaneClicked() {
		if (this.botLaneStyles.isActive) {
			this.game.registerLaneClick("LaneBot");
		}
	}

	public onDrawerButtonClicked(event: Event) {
		this.isDrawerOpen = !this.isDrawerOpen;
		event.stopPropagation();
	}

	public onAttackTopInhib(event: Event): void {
		if (this.game.getQueuedMove() && this.enemyInhibs[0].isActive) {
			this.game.registerNexusClick(Location.LaneTop);
		}
		event.stopPropagation();
	}

	public onAttackMidInhib(event: Event): void {
		if (this.game.getQueuedMove() && this.enemyInhibs[1].isActive) {
			this.game.registerNexusClick(Location.LaneTop);
		}
		event.stopPropagation();
	}

	public onAttackBotInhib(event: Event): void {
		if (this.game.getQueuedMove() && this.enemyInhibs[2].isActive) {
			this.game.registerNexusClick(Location.LaneTop);
		}
		event.stopPropagation();
	}
}
