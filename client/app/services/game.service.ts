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
	private enemyNexusHealth: Wrapper<number>;
	private playerNexusHealth: Wrapper<number>;

	/** Champion that is currently clicked to show controls */
	private controlChampId: string;

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
		this.enemyNexusHealth = { value: -1 };
		this.playerNexusHealth = { value: -1 };
		this.controlChampId = null;
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
				console.log(msg);
				for (let i = 0; i < msg.hand.length; i++) {
					this.addChampion(msg.hand[i]);
				}
				this.enemyNexusHealth.value = msg.nexusHealth;
				this.enemyNexusHealth.value = msg.nexusHealth;
				this.gameState.value = GameState.Started;
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

	public getEnemyNexusHealth(): Wrapper<number> {
		return this.enemyNexusHealth;
	}

	public getPlayerNexusHealth(): Wrapper<number> {
		return this.playerNexusHealth;
	}

	public getQueuedMove(): {uid: string, moveType: string} {
		return this.queuedMove;
	}

	public setControlChamp(uid: string): void {
		if (this.controlChampId) {
			this.champStyles[this.controlChampId].isControl = false;
		}
		this.champStyles[uid].isControl = true;
		this.controlChampId = uid;
	}

	public unsetControlChamp(uid: string): void {
		this.champStyles[uid].isControl = false;
		this.controlChampId = null;
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

	public removeChampion(champ: I.ChampionData): void {
		delete this.champStyles[champ.uid];
		delete this.champDict[champ.uid]
		this.activeChamps.splice(this.activeChamps.indexOf(champ), 1);

		switch (champ.currentLocation) {
			case I.Location.Hand:
				this.activeChamps.splice(this.activeChamps.indexOf(champ), 1);
				break;
			case I.Location.LaneTop:
				if (champ.owner === this.playerId) {
					this.topLaneAllies.splice(this.activeChamps.indexOf(champ), 1);
				} else {
					this.topLaneEnemies.splice(this.activeChamps.indexOf(champ), 1);
				}
				break;
			case I.Location.LaneMid:
				if (champ.owner === this.playerId) {
					this.midLaneAllies.splice(this.activeChamps.indexOf(champ), 1);
				} else {
					this.midLaneEnemies.splice(this.activeChamps.indexOf(champ), 1);
				}
				break;
			case I.Location.LaneBot:
				if (champ.owner === this.playerId) {
					this.botLaneAllies.splice(this.activeChamps.indexOf(champ), 1);
				} else {
					this.botLaneEnemies.splice(this.activeChamps.indexOf(champ), 1);
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
			this.applyUpdateDamaged(update);
		}

		if (update.killed) {
			this.applyUpdateKilled(update);
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

	private applyUpdateDamaged(update: I.DataGameUpdate): void {
		for (let data of update.damaged) {
			let champ = this.champDict[data.uid];
			champ.health = data.health;
		}
	}

	private applyUpdateKilled(update: I.DataGameUpdate): void {
		for (let data of update.killed) {
			let champ = this.champDict[data.uid];
			this.removeChampion(champ);
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

	public registerChampionAttack(uid: string): boolean {
		if (this.queuedMove) {
			console.log("Someone is already moving");
			return false;
		}
		this.queuedMove = { uid: uid, moveType: "attack"};
		this.setValidTargets();
		this.champStyles[uid].isSource = true;
		return true;
	}

	public registerChampionMove(uid: string): boolean {
		if (this.queuedMove) {
			console.log("Someone is already moving");
			return false;
		}
		this.queuedMove = { uid: uid, moveType: "move"};
		this.setValidTargets();
		this.champStyles[uid].isSource = true;
		return true;
	}

	public registerChampionAbility(uid: string): boolean {
		if (this.queuedMove) {
			console.log("Someone is already moving");
			return false;
		}

		if (this.champDict[uid].ability.type === I.AbilityType.SingleEnemySameLane
				|| this.champDict[uid].ability.type === I.AbilityType.SingleEnemyAnyLane
				|| this.champDict[uid].ability.type === I.AbilityType.SingleAlly) {
			this.queuedMove = { uid: uid, moveType: "ability"};
			this.setValidTargets();
			this.champStyles[uid].isSource = true;
			return true;
		} else {
			let msg: I.DataGameMove = {
				playerId: this.playerId,
				ability: {
					sourceUid: uid
				}
			}
			this.send("gamemove", msg);
			return false;
		}
	}

	public registerChampionClick(uid: string): void {
		if (!this.queuedMove) {
			console.log("No one is attacking");
			return;
		}

		let msg: I.DataGameMove;
		if (this.queuedMove.moveType === "attack") {
			msg = {
				playerId: this.playerId,
				attackChamp: {
					sourceUid: this.queuedMove.uid,
					targetUid: uid
				}
			}
		} else if (this.queuedMove.moveType === "ability" ) {
			msg = {
				playerId: this.playerId,
				ability: {
					sourceUid: this.queuedMove.uid,
					targetUid: uid
				}
			}
		} else {
			return;
		}

		this.send('gamemove', msg);
		this.clearAllTargets();
		this.champStyles[this.queuedMove.uid].isSource = false;
		this.queuedMove = null;
	}

	public registerLaneClick(lane: string): void {
		if (!this.queuedMove) {
			console.log("No one is moving");
			return;
		}
		if (this.queuedMove.moveType !== "move") {
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
		this.champStyles[this.queuedMove.uid].isSource = false;
		this.queuedMove = null;
	}

	public cancelMove(): void {
		if (this.queuedMove) {
			this.champStyles[this.queuedMove.uid].isSource = false;
			this.queuedMove = null;
		}
	}

	private setValidTargets() {
		switch (this.queuedMove.moveType) {
			case "move":
				this.laneStyles.forEach(s => s.isActive = true);
				break;
			case "attack":
				for (let i = 0; i < this.activeChamps.length; i++) {
					let curr = this.activeChamps[i];
					if (this.champDict[this.queuedMove.uid].currentLocation === curr.currentLocation
							&& curr.owner !== this.playerId) {
						this.champStyles[curr.uid].isActive = true;
					}
				}
				break;
			case "ability":
				let champ = this.champDict[this.queuedMove.uid];
				if (champ.ability.type === I.AbilityType.SingleEnemySameLane) {
					for (let i = 0; i < this.activeChamps.length; i++) {
						let curr = this.activeChamps[i];
						if (this.champDict[this.queuedMove.uid].currentLocation === curr.currentLocation
								&& curr.owner !== this.playerId) {
							this.champStyles[curr.uid].isActive = true;
						}
					}
				} else if (champ.ability.type === I.AbilityType.SingleEnemyAnyLane) {
					for (let i = 0; i < this.activeChamps.length; i++) {
						let curr = this.activeChamps[i];
						if (curr.owner !== this.playerId) {
							this.champStyles[curr.uid].isActive = true;
						}
					}
				} else if (champ.ability.type === I.AbilityType.SingleAlly) {
					for (let i = 0; i < this.activeChamps.length; i++) {
						let curr = this.activeChamps[i];
						if (this.champDict[this.queuedMove.uid].currentLocation === curr.currentLocation
								&& curr.owner === this.playerId) {
							this.champStyles[curr.uid].isActive = true;
						}
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
