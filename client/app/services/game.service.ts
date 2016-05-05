import {Injectable} from 'angular2/core';
import {ChampionDto, Dictionary, GameState, Style, Wrapper} from '../interfaces/interfaces';
import * as I from '../interfaces/data.interfaces';
import {ChampionHelper} from '../helpers/champion.helper';

@Injectable()
export class GameService {
	private sock: SocketIOClient.Socket;
	private playerId: string;
	private gameId: string;
	private gameState: Wrapper<GameState>;
	private activeChamps: I.ChampionData[];
	private champDict: Dictionary<I.ChampionData>;
	private champStyles: Dictionary<Style>;
	private currentPlayerId: string;
	private laneStyles: Style[];

	/** Lanes */
	private topLaneAllies: I.ChampionData[];
	private midLaneAllies: I.ChampionData[];
	private botLaneAllies: I.ChampionData[];
	private topLaneEnemies: I.ChampionData[];
	private midLaneEnemies: I.ChampionData[];
	private botLaneEnemies: I.ChampionData[];
	private hand: I.ChampionData[];

	private queuedMove: {uid: string, moveType: string};

	constructor() {
		this.gameState = { value: GameState.Waiting };
		this.activeChamps = [];
		this.topLaneAllies = [];
		this.midLaneAllies = [];
		this.botLaneAllies = [];
		this.topLaneEnemies = [];
		this.midLaneEnemies = [];
		this.botLaneEnemies = [];
		this.hand = [];
		this.champDict = {};
		this.champStyles = {};
		this.laneStyles = [{isActive: false}, {isActive: false}, {isActive: false}];
		this.initializeSockets();
	}

	private initializeSockets(): void {
		this.sock = io();

		this.sock.once('gamejoin-ack', (res: I.DataGameJoinAck) => {
			if (!res.success) {
				console.log('Could not connect to game: ' + res.reason);
				this.sock.close();
				return;
			}

			this.playerId = res.playerId;

			this.sock.on('gameprep', (msg: I.DataGamePrep) => {
				console.log(msg);
				this.gameState.value = GameState.NotStarted;
			});

			this.sock.on('gameselect-ack', (msg: I.DataGameSelectAck) => {
				console.log(msg);
			});

			this.sock.on('gameinit', (msg: I.DataGameInit) => {
				console.log(msg.hand);
				this.gameState.value = GameState.Started;
				for (let i = 0; i < msg.hand.length; i++) {
					this.addChampion(msg.hand[i]);
				}
			});

			this.sock.on('gameupdate', (msg: I.DataGameUpdate) => {
				console.log(msg);
				this.applyUpdate(msg);
			});

			this.sock.on('gameerror', (msg: I.DataGameError) => {
				console.log(msg);
			});
		});

		let joinData: I.DataGameJoin = {gameId: this.getGameId()};
		this.sock.emit('gamejoin', joinData);
	}

	public getGameId(): string {
		if (!this.gameId) {
			this.gameId = window.location.pathname.substr(-12);
		}
		return this.gameId;
	}

	public getGameState(): Wrapper<GameState> {
		return this.gameState;
	}

	public getActiveChamps(): I.ChampionData[] {
		return this.activeChamps;
	}

	public send(event: string, data: any): void {
		this.sock.emit(event, data);
	}

	public getPlayerId(): string {
		return this.playerId;
	}

	public getChampStyle(uid: string): Style {
		return this.champStyles[uid];
	}

	public getTopLaneAllies(): I.ChampionData[] {
		return this.topLaneAllies;
	}

	public getMidLaneAllies(): I.ChampionData[] {
		return this.midLaneAllies;
	}

	public getBotLaneAllies(): I.ChampionData[] {
		return this.botLaneAllies;
	}

	public getTopLaneEnemies(): I.ChampionData[] {
		return this.topLaneEnemies;
	}

	public getMidLaneEnemies(): I.ChampionData[] {
		return this.midLaneEnemies;
	}

	public getBotLaneEnemies(): I.ChampionData[] {
		return this.botLaneEnemies;
	}

	public getLaneStyles(i: number): Style {
		return this.laneStyles[i];
	}

	public getHand(): I.ChampionData[] {
		return this.hand;
	}

	public addChampion(champ: I.ChampionData): void {
		this.champStyles[champ.uid] = {
			isActive: false
		};
		this.champDict[champ.uid] = champ;
		this.activeChamps.push(champ);

		switch (champ.currentLocation) {
			case I.Location.Hand:
				this.hand.push(champ);
				break;
			case I.Location.LaneTop:
				if (champ.owner === this.playerId) {
					this.topLaneAllies.push(champ);
				} else {
					this.topLaneEnemies.push(champ);
				}
				break;
			case I.Location.LaneMid:
				if (champ.owner === this.playerId) {
					this.midLaneAllies.push(champ);
				} else {
					this.midLaneEnemies.push(champ);
				}
				break;
			case I.Location.LaneBot:
				if (champ.owner === this.playerId) {
					this.botLaneAllies.push(champ);
				} else {
					this.botLaneEnemies.push(champ);
				}
				break;
		}
	}

	public applyUpdate(update: I.DataGameUpdate): void {
		if (update.moved) {
			this.applyUpdateMove(update);
		}

		if (update.hand) {
			this.applyUpdateHand(update);
		}

		if (update.enemySpawn) {
			this.applyUpdateEnemySpawn(update);
		}

		if (update.damaged) {

		}

		if (update.killed) {

		}

		if (update.nexus) {

		}
	}

	private applyUpdateMove(update: I.DataGameUpdate):void {
		for (let data of update.moved) {
			let champ = this.champDict[data.uid];

			if (champ.owner === this.playerId) {
				this.removeAllyFromLane(champ, champ.currentLocation);
				this.addAllyToLane(champ, data.location);
			} else {
				this.removeEnemyFromLane(champ, champ.currentLocation);
				this.addEnemyToLane(champ, data.location);
			}

			champ.currentLocation = data.location;
		}
	}

	private applyUpdateHand(update: I.DataGameUpdate): void {
		for (let data of update.hand) {
			this.addChampion(data);
		}
	}

	private applyUpdateEnemySpawn(update: I.DataGameUpdate): void {
		for (let data of update.enemySpawn) {
			this.addChampion(data);
		}
	}

	public addAllyToLane(champ: I.ChampionData, lane: I.Location) {
		switch(lane) {
			case I.Location.LaneTop:
				this.topLaneAllies.push(champ);
				break;
			case I.Location.LaneMid:
				this.midLaneAllies.push(champ);
				break;
			case I.Location.LaneBot:
				this.botLaneAllies.push(champ);
				break;
		}
	}

	public addEnemyToLane(champ: I.ChampionData, lane: I.Location) {
		switch(lane) {
			case I.Location.LaneTop:
				this.topLaneEnemies.push(champ);
				break;
			case I.Location.LaneMid:
				this.midLaneEnemies.push(champ);
				break;
			case I.Location.LaneBot:
				this.botLaneEnemies.push(champ);
				break;
		}
	}

	public removeAllyFromLane(champ: I.ChampionData, lane: I.Location) {
		switch(lane) {
			case I.Location.Hand:
				ChampionHelper.removeChampion(this.hand, champ);
				break;
			case I.Location.LaneTop:
				ChampionHelper.removeChampion(this.topLaneAllies, champ);
				break;
			case I.Location.LaneMid:
				ChampionHelper.removeChampion(this.midLaneAllies, champ);
				break;
			case I.Location.LaneBot:
				ChampionHelper.removeChampion(this.botLaneAllies, champ);
				break;
		}
	}

	public removeEnemyFromLane(champ: I.ChampionData, lane: I.Location) {
		switch(lane) {
			case I.Location.LaneTop:
				ChampionHelper.removeChampion(this.topLaneEnemies, champ);
				break;
			case I.Location.LaneMid:
				ChampionHelper.removeChampion(this.midLaneEnemies, champ);
				break;
			case I.Location.LaneBot:
				ChampionHelper.removeChampion(this.botLaneEnemies, champ);
				break;
		}
	}

	public registerChampionAttack(uid: string): void {
		if (this.queuedMove) {
			console.log("Someone is already attacking");
			return;
		}
		this.queuedMove = { uid: uid, moveType: "attack"};
		this.setValidTargets();
	}

	public registerChampionMove(uid: string): void {
		if (this.queuedMove) {
			console.log("Someone is already moving");
			return;
		}
		this.queuedMove = { uid: uid, moveType: "move"};
		this.setValidTargets();
	}

	public registerChampionClick(uid: string): void {
		if (!this.queuedMove) {
			console.log("No one is attacking");
			return;
		}

		let msg: I.DataGameMove = {
			playerId: this.playerId,
			attackChamp: {
				sourceUid: this.queuedMove.uid,
				targetUid: uid
			}
		}

		this.send('gamemove', msg);
		this.clearAllTargets();
		this.queuedMove = null;
	}

	public registerLaneClick(lane: string): void {
		if (!this.queuedMove) {
			console.log("No one is moving");
			return;
		}

		let msg: I.DataGameMove = {
			playerId: this.playerId,
			moveChamp: {
				uid: this.queuedMove.uid,
				targetLocation: I.Location[lane]
			}
		}

		this.send('gamemove', msg);
		this.clearAllTargets();
		this.queuedMove = null;
	}

	public cancelMove(): void {
		this.queuedMove = null;
	}

	private setValidTargets() {
		switch (this.queuedMove.moveType) {
			case "move":
				this.laneStyles.forEach(s => s.isActive = true);
				break;
			case "attack":
				for (let i = 0; i < this.activeChamps.length; i++) {
					let curr = this.activeChamps[i].uid;
					if (this.champDict[this.queuedMove.uid].currentLocation === this.champDict[curr].currentLocation
							&& this.champDict[curr].owner !== this.playerId) {
						this.champStyles[this.activeChamps[i].uid].isActive = true;
					}
				}
				break;
		}
	}

	private clearAllTargets() {
		switch (this.queuedMove.moveType) {
			case "move":
				this.laneStyles.forEach(s => s.isActive = false);
				break;
			case "attack":
				for (let i = 0; i < this.activeChamps.length; i++) {
					this.champStyles[this.activeChamps[i].uid].isActive = false;
				}
				break;
		}
	}
}
