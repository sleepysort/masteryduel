import {Injectable} from 'angular2/core';
import {ChampionDto, Dictionary, GameState, Style, Wrapper} from '../interfaces/interfaces';
import * as I from '../interfaces/data.interfaces';
import {ChampionHelper} from '../helpers/champion.helper';
import {MessageLogger} from '../helpers/messagelogger';

@Injectable()
export class GameService {
	private sock: SocketIOClient.Socket;
	private playerId: string;
	private gameId: string;
	private gameState: Wrapper<GameState>;
	private turnNum: Wrapper<number>;
	private activeChamps: I.ChampionData[];
	private champDict: Dictionary<I.ChampionData>;
	private champStyles: Dictionary<Style>;
	private enemyInhibStyles: Style[];
	private laneStyles: Style[];
	private playerIconNumber: number;
	private enemyIconNumber: number;
	private playerSummonerName: string;
	private enemySummonerName: string;

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
	/** 1 for player, -1 for enemy, 0 for neither */
	private isPlayerTurn: Wrapper<number>;
	private currentTurnMovesLeft: Wrapper<number>;

	/** Champion that is currently clicked to show controls */
	private controlChampId: string;

	/** How much time is left in the turn */
	private timeleft: Wrapper<number>;

	/** The interval id of the timer */
	private timerInterval: number;

	/** The id of the winner */
	private isVictor: Wrapper<boolean>;

	/** True when a new message has arrived */
	private hasNewMessage: Wrapper<boolean>;

	/** Error message for deck loading */
	private loadingMsg: Wrapper<string>;

	constructor() {
		this.gameState = { value: GameState.Waiting };
		this.turnNum = { value: 0 };
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
		this.enemyInhibStyles = [{isActive: false}, {isActive: false}, {isActive: false}];
		this.initializeSockets();
		this.enemyNexusHealth = { value: -1 };
		this.playerNexusHealth = { value: -1 };
		this.isPlayerTurn = { value: 0 };
		this.currentTurnMovesLeft = { value: 0 };
		this.controlChampId = null;
		this.playerIconNumber = 0;
		this.enemyIconNumber = 0;
		this.playerSummonerName = '';
		this.enemySummonerName = '';
		this.timeleft = { value: 0 };
		this.isVictor = { value: false };
		this.hasNewMessage = { value: false };
		this.loadingMsg = { value: null };
	}

	private initializeSockets(): void {
		this.sock = io();

		this.sock.once('gamejoin-ack', (res: I.DataGameJoinAck) => {
			if (!res.success) {
				MessageLogger.systemMessage('Failed to join the game. ' + res.reason);
				this.hasNewMessage.value = true;
				this.sock.close();
				return;
			}

			this.playerId = res.playerId;

			this.sock.once('gameprep', (msg: I.DataGamePrep) => {
				this.gameState.value = GameState.NotStarted;
			});

			this.sock.on('gameselect-ack', (msg: I.DataGameSelectAck) => {
				if (msg.success) {
					MessageLogger.systemMessage('Deck successfully loaded.');
					this.hasNewMessage.value = true;
					this.loadingMsg.value = 'Summoner found! Please wait for the opponent to select a summoner.';
				} else {
					MessageLogger.systemMessage('Failed to load the deck.');
					this.hasNewMessage.value = true;
					this.loadingMsg.value = msg.reason;
				}
			});

			this.sock.on('gamechat', (msg: I.DataGameChat) => {
				if (msg.playerId === this.playerId) {
					MessageLogger.playerChatMessage(msg.text);
					this.hasNewMessage.value = true;
				} else {
					MessageLogger.opponentChatMessage(msg.text);
					this.hasNewMessage.value = true;
				}
			});

			this.sock.on('gameinit', (msg: I.DataGameInit) => {
				for (let i = 0; i < msg.hand.length; i++) {
					this.addChampion(msg.hand[i]);
				}

				MessageLogger.systemMessage('The game is starting! GLHF');
				this.hasNewMessage.value = true;

				this.enemyNexusHealth.value = msg.nexusHealth;
				this.playerNexusHealth.value = msg.nexusHealth;
				this.isPlayerTurn.value = msg.starter === this.playerId ? 1 : -1;
				this.turnNum.value = 1;
				this.playerIconNumber = msg.playerIcon;
				this.enemyIconNumber = msg.enemyIcon;
				this.playerSummonerName = msg.playerSummonerName;
				this.enemySummonerName = msg.enemySummonerName;
				this.gameState.value = GameState.Started;

				this.currentTurnMovesLeft.value = 2;

				this.timeleft.value = 75;
				this.timerInterval = setInterval(this.intervalHandler, 1000);
			});

			this.sock.on('gameupdate', (msg: I.DataGameUpdate) => {
				this.applyUpdate(msg);

				this.timeleft.value = 75;
				clearInterval(this.timerInterval);
				this.timerInterval = setInterval(this.intervalHandler, 1000);
			});

			this.sock.on('gameover', (msg: I.DataGameOver) => {
				clearTimeout(this.timerInterval);

				if (msg.victor === null) {
					MessageLogger.systemMessage('Your opponent has disconnected.');
					this.hasNewMessage.value = true;
				} else if (msg.victor === this.playerId){
					MessageLogger.systemMessage('You are victorious!');
					this.hasNewMessage.value = true;
					this.isVictor.value = true;
				} else {
					MessageLogger.systemMessage('You have been defeated!');
					this.hasNewMessage.value = true;
					this.isVictor.value = false;
				}

				this.gameState.value = GameState.Over;
				this.sock.disconnect();
			})

			this.sock.on('gameerror', (msg: I.DataGameError) => {
				MessageLogger.systemMessage('Server sent an error: ' + msg.reason);
				this.hasNewMessage.value = true;
			});
		});

		let joinData: I.DataGameJoin = {gameId: this.getGameId()};
		this.sock.emit('gamejoin', joinData);
	}

	public intervalHandler = () => {
		if (this.timeleft.value !== 0) {
			this.timeleft.value--;
		}
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

	public getCurrentTurnNum(): Wrapper<number> {
		return this.turnNum;
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

	public getEnemyInhibStyles(): Style[] {
		return this.enemyInhibStyles;
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

	public getIsPlayerTurn(): Wrapper<number> {
		return this.isPlayerTurn;
	}

	public getCurrentTurnMovesLeft(): Wrapper<number> {
		return this.currentTurnMovesLeft;
	}

	public getQueuedMove(): {uid: string, moveType: string} {
		return this.queuedMove;
	}

	public getPlayerIconNumber(): number {
		return this.playerIconNumber;
	}

	public getEnemyIconNumber(): number {
		return this.enemyIconNumber;
	}

	public getPlayerSummonerName(): string {
		return this.playerSummonerName;
	}

	public getEnemySummonerName(): string {
		return this.enemySummonerName;
	}

	public getTimeLeft(): Wrapper<number> {
		return this.timeleft;
	}

	public getIsVictor(): Wrapper<boolean> {
		return this.isVictor;
	}

	public getHasNewMessage(): Wrapper<boolean> {
		return this.hasNewMessage;
	}

	public getLoadingMessage(): Wrapper<string> {
		return this.loadingMsg;
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
				this.hand.splice(this.hand.indexOf(champ), 1);
				break;
			case I.Location.LaneTop:
				if (champ.owner === this.playerId) {
					this.topLaneAllies.splice(this.topLaneAllies.indexOf(champ), 1);
				} else {
					this.topLaneEnemies.splice(this.topLaneEnemies.indexOf(champ), 1);
				}
				break;
			case I.Location.LaneMid:
				if (champ.owner === this.playerId) {
					this.midLaneAllies.splice(this.midLaneAllies.indexOf(champ), 1);
				} else {
					this.midLaneEnemies.splice(this.midLaneEnemies.indexOf(champ), 1);
				}
				break;
			case I.Location.LaneBot:
				if (champ.owner === this.playerId) {
					this.botLaneAllies.splice(this.botLaneAllies.indexOf(champ), 1);
				} else {
					this.botLaneEnemies.splice(this.botLaneEnemies.indexOf(champ), 1);
				}
				break;
		}
	}

	public applyUpdate(update: I.DataGameUpdate): void {
		if (update.moved && update.moved.length !== 0) {
			this.applyUpdateMove(update);
		}

		if (update.enemySpawn && update.enemySpawn.length !== 0) {
			this.applyUpdateEnemySpawn(update);
		}

		if (update.damaged && update.damaged.length !== 0) {
			this.applyUpdateDamaged(update);
		}

		if (update.killed && update.killed.length !== 0) {
			this.applyUpdateKilled(update);
		}

		if (update.affected && update.affected.length !== 0) {
			this.applyUpdateAffected(update);
		}

		if (update.hand && update.hand.length !== 0) {
			this.applyUpdateHand(update);
		}

		if (update.cooldown && update.cooldown.length !== 0) {
			this.applyUpdateCooldown(update);
		}

		if (update.damageChange && update.damageChange.length !== 0) {
			this.applyUpdateDamageChange(update);
		}

		if (update.nexus) {
			this.applyUpdateNexus(update);
		}

		this.isPlayerTurn.value = update.turnPlayer === this.playerId ? 1 : -1 ;

		// Ignore for debug
		if (update.sourceUid) {
			this.champDict[update.sourceUid].movedNum = update.movedNum;
		}

		this.currentTurnMovesLeft.value = update.moveCount;

		this.turnNum.value = update.turnNum;
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

	private applyUpdateAffected(update: I.DataGameUpdate): void {
		for (let data of update.affected) {
			let champ = this.champDict[data.uid];
			switch (data.status) {
				case I.Status.Stunned:
					champ.stunnedTurn = data.turnNum;
					break;
				case I.Status.Invulnerable:
					champ.invulnTurn = data.turnNum;
					break;
				case I.Status.Stasis:
					champ.stasisTurn = data.turnNum;
					break;
				case I.Status.DamageReduction:
					champ.statusEndTurn[I.Status.DamageReduction] = data.turnNum;
					break;
				case I.Status.Shielded:
					champ.statusEndTurn[I.Status.Shielded] = data.turnNum;
					break;
				case I.Status.DamageBuff:
					champ.statusEndTurn[I.Status.DamageBuff] = data.turnNum;
					break;
				case I.Status.Marked:
					champ.statusEndTurn[I.Status.Marked] = data.turnNum;
					break;
			}
		}
	}

	private applyUpdateDamageChange(update: I.DataGameUpdate): void {
		for (let champ of update.damageChange) {
			this.champDict[champ.uid].dmg = champ.dmg;
		}
	}

	private applyUpdateNexus(update: I.DataGameUpdate): void {
		for (let playerId in update.nexus) {
			if (playerId === this.playerId) {
				this.playerNexusHealth.value = update.nexus[playerId];
			} else {
				this.enemyNexusHealth.value = update.nexus[playerId];
			}
		}
	}

	private applyUpdateCooldown(update: I.DataGameUpdate): void {
		for (let a of update.cooldown) {
			this.champDict[a.uid].ability.readyTurn = a.readyTurn;
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
			MessageLogger.systemMessage('Another champion is already trying to make a move.');
			this.hasNewMessage.value = true;
			return false;
		}

		if (this.champDict[uid].stunnedTurn >= this.turnNum.value) {
			MessageLogger.systemMessage('This champion is stunned.');
			this.hasNewMessage.value = true;
			return false;
		}

		if (this.champDict[uid].stasisTurn >= this.turnNum.value) {
			MessageLogger.systemMessage('This champion is in stasis.');
			this.hasNewMessage.value = true;
			return false;
		}

		if (this.champDict[uid].movedNum >= this.turnNum.value) {
			MessageLogger.systemMessage("This champion has already made a move this turn.");
			this.hasNewMessage.value = true;
			return false;
		}

		this.queuedMove = { uid: uid, moveType: "attack"};
		this.setValidTargets();
		this.champStyles[uid].isSource = true;
		return true;
	}

	public registerChampionMove(uid: string): boolean {
		if (this.queuedMove) {
			MessageLogger.systemMessage('Another champion is already trying to make a move.');
			this.hasNewMessage.value = true;
			return false;
		}

		if (this.champDict[uid].stunnedTurn >= this.turnNum.value) {
			MessageLogger.systemMessage("This champion is stunned.");
			this.hasNewMessage.value = true;
			return false;
		}

		if (this.champDict[uid].stasisTurn >= this.turnNum.value) {
			MessageLogger.systemMessage('This champion is in stasis.');
			this.hasNewMessage.value = true;
			return false;
		}

		if (this.champDict[uid].movedNum >= this.turnNum.value) {
			MessageLogger.systemMessage("This champion has already made a move this turn.");
			this.hasNewMessage.value = true;
			return false;
		}

		this.queuedMove = { uid: uid, moveType: "move"};
		this.setValidTargets();
		this.champStyles[uid].isSource = true;
		return true;
	}

	public registerChampionAbility(uid: string): boolean {
		if (this.queuedMove) {
			MessageLogger.systemMessage('Another champion is already trying to make a move.');
			this.hasNewMessage.value = true;
			return false;
		}

		if (this.champDict[uid].ability.readyTurn >= this.turnNum.value) {
			MessageLogger.systemMessage('This ability is on cooldown.');
			this.hasNewMessage.value = true;
			return false;
		}

		if (this.champDict[uid].stunnedTurn >= this.turnNum.value) {
			MessageLogger.systemMessage("This champion is stunned.");
			this.hasNewMessage.value = true;
			return false;
		}

		if (this.champDict[uid].stasisTurn >= this.turnNum.value) {
			MessageLogger.systemMessage('This champion is in stasis.');
			this.hasNewMessage.value = true;
			return false;
		}

		if (this.champDict[uid].movedNum >= this.turnNum.value) {
			MessageLogger.systemMessage("This champion has already made a move this turn.");
			this.hasNewMessage.value = true;
			return false;
		}

		if (this.champDict[uid].ability.type === I.AbilityType.SingleEnemySameLane
				|| this.champDict[uid].ability.type === I.AbilityType.SingleEnemyAnyLane
				|| this.champDict[uid].ability.type === I.AbilityType.SingleAllySameLane
				|| this.champDict[uid].ability.type === I.AbilityType.SingleAllyAnyLane) {
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
			this.champStyles[uid].isControl = false;
			this.send("gamemove", msg);
			return false;
		}
	}

	public registerChampionClick(uid: string): void {
		if (!this.queuedMove) {
			MessageLogger.systemMessage("No one is currently attacking.");
			this.hasNewMessage.value = true;
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

	public registerNexusClick(location: I.Location): void {
		if (!this.queuedMove) {
			MessageLogger.systemMessage("No one is currently attacking.");
			this.hasNewMessage.value = true;
			return;
		}

		if (this.queuedMove.moveType !== "attack") {
			return;
		}

		let msg: I.DataGameMove = {
			playerId: this.playerId,
			attackNexus: {
				uid: this.queuedMove.uid,
			}
		};

		this.send('gamemove', msg);
		this.clearAllTargets();
		this.champStyles[this.queuedMove.uid].isSource = false;
		this.queuedMove = null;
	}

	public registerLaneClick(lane: string): void {
		if (!this.queuedMove) {
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
			this.clearAllTargets();
			this.champStyles[this.queuedMove.uid].isSource = false;
			this.queuedMove = null;
		}
	}

	private setValidTargets() {
		switch (this.queuedMove.moveType) {
			case "move":
				let champLoc = this.champDict[this.queuedMove.uid].currentLocation;
				switch (champLoc) {
					case I.Location.Hand:
						this.laneStyles.forEach(s => s.isActive = true);
						break;
					case I.Location.LaneTop:
					case I.Location.LaneBot:
						this.laneStyles[1].isActive = true;
						break;
					case I.Location.LaneMid:
						this.laneStyles[0].isActive = true;
						this.laneStyles[2].isActive = true;
						break;
				}
				break;
			case "attack":
				let enemyInLane = false;
				for (let i = 0; i < this.activeChamps.length; i++) {
					let curr = this.activeChamps[i];
					if (this.champDict[this.queuedMove.uid].currentLocation === curr.currentLocation
							&& curr.owner !== this.playerId
							&& curr.invulnTurn < this.turnNum.value) {
						this.champStyles[curr.uid].isActive = true;
						enemyInLane = true;
					}
				}
				if (!enemyInLane && this.champDict[this.queuedMove.uid].currentLocation !== I.Location.Hand) {
					this.enemyInhibStyles[this.champDict[this.queuedMove.uid].currentLocation - 2].isActive = true;
				}
				break;
			case "ability":
				let champAbility = this.champDict[this.queuedMove.uid].ability;
				if (champAbility.type === I.AbilityType.SingleEnemySameLane) {
					for (let i = 0; i < this.activeChamps.length; i++) {
						let curr = this.activeChamps[i];
						if (this.champDict[this.queuedMove.uid].currentLocation === curr.currentLocation
								&& curr.owner !== this.playerId
								&& curr.invulnTurn < this.turnNum.value) {
							this.champStyles[curr.uid].isActive = true;
						}
					}
				} else if (champAbility.type === I.AbilityType.SingleEnemyAnyLane
						|| champAbility.type === I.AbilityType.AOEEnemyAnyLane) {
					for (let i = 0; i < this.activeChamps.length; i++) {
						let curr = this.activeChamps[i];
						if (curr.owner !== this.playerId
								&& curr.invulnTurn < this.turnNum.value) {
							this.champStyles[curr.uid].isActive = true;
						}
					}
				} else if (champAbility.type === I.AbilityType.SingleAllySameLane) {
					for (let i = 0; i < this.activeChamps.length; i++) {
						let curr = this.activeChamps[i];
						if (this.champDict[this.queuedMove.uid].currentLocation === curr.currentLocation
								&& curr.owner === this.playerId) {
							this.champStyles[curr.uid].isActive = true;
						}
					}
				} else if (champAbility.type === I.AbilityType.SingleAllyAnyLane) {
					for (let i = 0; i < this.activeChamps.length; i++) {
						let curr = this.activeChamps[i];
						if (curr.owner === this.playerId) {
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
				for (let inhib of this.enemyInhibStyles) {
					inhib.isActive = false;
				}
				break;
			case "ability":
				for (let i = 0; i < this.activeChamps.length; i++) {
					this.champStyles[this.activeChamps[i].uid].isActive = false;
				}
				break;
		}
	}
}
