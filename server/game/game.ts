import fetcher = require('./fetcher');
import gm = require('./gamesmanager');
import constants = require('../constants');

// Generates a random string id
export function generateId(length: number): string {
	let chars = "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";
	let result = "";
	for (let i = 0; i < length; i++) {
		result += chars.charAt(Math.floor(Math.random() * chars.length));
	}
	return result;
}

export class Game {
	private gamesManager: gm.GamesManager;
	private gameId: string;
	private gameState: GameState;

	/**
	 * The turn number of the game
	 * 0 is before the game starts
	 * Nexus is invulnerable until turn 4
	 */
	private turnNum: number;
	private movesCount: number;
	private activeChamps: {[uid: string]: Champion};
	private players: Player[];

	constructor(gamesManager: gm.GamesManager, gameId: string) {
		this.gamesManager = gamesManager;
		this.gameId = gameId;
		this.gameState = GameState.Waiting;
		this.turnNum = 0;
		this.movesCount = 0;
		this.activeChamps = {};
		this.players = [];
	}

	public addPlayer(sock: SocketIO.Socket) {
		if (this.players.length === constants.MAX_PLAYERS) {
			throw new Error("The game is full.");
		}

		let playerId = generateId(6);
		let player = new Player(playerId, sock);
		this.players.push(player);

		console.log(playerId + ' joined ' + this.gameId + ' successfully');

		sock.on('disconnect', () => {
			console.log('player ' + playerId + ' disconnected');
			this.players.splice(this.players.indexOf(player), 1);
			this.gameState = GameState.Over;
			this.emitAll('gameover', { reason: 'Player disconnected' });
			if (this.isGameEmpty()) {
				this.gamesManager.removeGame(this.gameId);
			}
			return;
		});

        sock.emit('gamejoin-ack', {
            success: true,
            playerId: playerId
        });

		if (this.players.length === constants.MAX_PLAYERS) {
			this.gameState = GameState.NotStarted;

			console.log('Two players joined. Waiting for summoners.');
			this.emitAll('gameprep', { message: "Select a summoner deck." });
			// TODO: wait for summoner selection
			this.onAll('gameselect', (msg: any) => {
				console.log(msg.playerId + ' selecting ' + msg.summonerName);
				let player = this.getPlayer(msg.playerId);
				fetcher.getSummonerId(msg.summonerName)
						.then(fetcher.getSummonerDeck)
						.then((value: any[]) => {
							player.setDeck(Deck.createDeck(msg.summonerName, value));
							console.log(msg.playerId + ' loaded ' + msg.summonerName + ' deck');
							player.getSocket().emit('gameselect-ack', { succcess: true });
							return this.isGameReady();
						}).then((value: boolean) => {
							if (value) {
								console.log('both players loaded. starting game.');
								this.initializeGame();
								this.offAll('gameselect');
								this.onAll('gamemove', (move: any) => {
									this.applyMove(move);
								});
							}
						});
			});
			let x = (r) => r;
		}

		return playerId;
	}

	public getPlayer(playerId: string): Player {
		for (let i = 0; i < this.players.length; i++) {
			if (this.players[i].getId() === playerId) return this.players[i];
		}
		return null;
	}

	public getOpponent(playerId: string): Player {
		for (let i = 0; i < this.players.length; i++) {
			if (this.players[i].getId() !== playerId) return this.players[i];
		}
		return null;
	}

	public getHand(playerId: string): Champion[] {
		let player = this.getPlayer(playerId);
		let result = [];
		for (let uid in this.activeChamps) {
			if (this.activeChamps[uid].getOwner() === player.getId()
					&& this.activeChamps[uid].getLocation() === Location.Hand) {
				result.push(this.activeChamps[uid]);
			}
		}

		if (result.length !== 5) {
			throw new Error(playerId + 'does not have 5 cards in hand');
		}

		return result;
	}

	public emitAll(event: string, data?: any): void {
		for (let i = 0; i < this.players.length; i++) {
			this.players[i].getSocket().emit(event, data);
		}
	}

	public onAll(event: string, handler: any) {
		for (let i = 0; i < this.players.length; i++) {
			this.players[i].getSocket().on(event, handler);
		}
	}

	public offAll(event: string) {
		for (let i = 0; i < this.players.length; i++) {
			this.players[i].getSocket().removeAllListeners(event);
		}
	}

	public getPlayerCount(): number {
		return this.players.length;
	}

	public isGameReady(): boolean {
		console.log('checking for readiness');
		let ready = this.players.length === 2;
		for (let i = 0; i < this.players.length; i++) {
			ready = ready && this.players[i].isReady();
		}
		return ready;
	}

	public isGameEmpty(): boolean {
		return this.players.length === 0;
	}

	public start(): void {
		if (this.gameState === GameState.Started) {
			return;
		} else if (this.gameState === GameState.Over) {
			throw new Error("Game is already over.");
		} else if (this.gameState === GameState.Waiting) {
			throw new Error("Not enough players to start.");
		}
		this.gameState = GameState.Started;
	}

	public initializeGame(): void {
		this.start();
		this.turnNum = 1;
		this.movesCount = 2;
		console.log('initializing game ' + this.players.length);
		for (let i = 0; i < this.players.length; i++) {
			this.players[i].initializeHand(5, this.activeChamps);
			this.players[i].getSocket().emit('gameinit', {
				hand: this.getHand(this.players[i].getId()),
				starter: this.getCurrentTurnPlayer()
			});
		}
	}

	public getCurrentTurnPlayer(): string {
		return this.players[this.turnNum % this.players.length].getId();
	}

	public applyMove(move: any) {
		let player = this.getPlayer(move.playerId);
		let update: any = {};

		if (player.getId() !== this.getCurrentTurnPlayer()) {
			player.getSocket().emit('gameerror', {
				reason: 'It is not your turn to make a move.',
			});
			return;
		}

		try {
			if (move.attackNexus) {
				this.tryAttackNexus(player, move.attackNexus, update);
			} else if (move.attackChamp) {
				this.tryAttackChamp(player, move.attackChamp, update);
			} else if (move.ability) {
				this.tryAbility(player, move.ability, update);
			} else if (move.moveChamp) {
				console.log('moving...')
				this.tryMoveChamp(player, move.moveChamp, update);
			} else {  // Invalid move
				player.getSocket().emit('gameerror', {
					reason: 'Invalid move',
				});
				return;
			}
		} catch (err) {
			player.getSocket().emit('gameerror', {
				reason: err.message
			});
			return;
		}

		this.movesCount--;

		// Next player's turn
		if (this.movesCount === 0) {
			this.movesCount = 3;
			this.turnNum++;
		}

		this.tickFountains();

		update.turnNum = this.turnNum;
		update.turnPlayer = this.getCurrentTurnPlayer();

		// TODO: Instead of emitAll, process update so that each player only sees their own hand
		this.emitAll('gameupdate', update);
	}

	private tickFountains(): void {
		for (let i = 0; i < this.players.length; i++) {
			this.players[i].tickFountain();
		}
	}

	public tryAttackNexus(player: Player, data: any, update: any): void {
		let source = this.activeChamps[data.sourceUid];
		let opp = this.getOpponent(player.getId());

		// TODO: Check to see its not in hand
		// Check to see if there are enemies in the lane
		for (let uid in this.activeChamps) {
			let curr = this.activeChamps[uid];
			if (uid !== data.source && curr.getOwner() === opp.getId() && curr.getLocation() === source.getLocation()) {
				throw new Error('Enemy champion in the lane');
			}
		}

		if (opp.getInvulnTurn() >= this.turnNum) {
			throw new Error('Opponent nexus is invulnerable');
		}

		// If opponent health is zero, end the game
		if (opp.applyDamage(data.source.getDamage())) {
			this.gameOver(player);
		}

		// Add data to update object
		update.nexus = {};
		update.nexus[opp.getId()] = opp.getHealth();
	}

	public tryAttackChamp(player: Player, data: any, update: any): void {
		let source = this.activeChamps[data.sourceUid];
		let target = this.activeChamps[data.targetUid];

		if (!source || !target) {
			throw new Error('Invalid source or target');
		}

		if (source.getOwner() !== player.getId()) {
			throw new Error('Attacking champion is not owned by player');
		}

		if (target.getOwner() === player.getId()) {
			throw new Error('Cannot attack your own champion');
		}

		// Check source is not in hand
		// Check target is in same lane

		if (target.getInvulnTurn() >= this.turnNum) {
			throw new Error('Target is invulnerable');
		}

		update.killed = [];
		update.damaged = [];

		// If enemy is killed, send to fountain
		if (source.attackEnemy(target)) {
			this.getPlayer(target.getOwner()).sendToFountain(target);
			update.killed.push(target.getUid());
			delete this.activeChamps[target.getUid()];
		} else {
			update.damaged.push({
				uid: target.getUid(),
				health: target.getHealth()
			});
		}
	}

	public tryAbility(player: Player, data: any, update: any): void {
		throw new Error('Abilities not yet supported');
	}

	public tryMoveChamp(player: Player, data: any, update: any): void {
		let champ = this.activeChamps[data.uid];

		if (!champ) {
			throw new Error('Invalid champion');
		}

		if (champ.getOwner() !== player.getId()) {
			throw new Error('Cannot move opponent champion');
		}

		if (data.targetLocation === champ.getLocation()) {
			throw new Error('Champion is already at this location');
		}

		if (data.targetLocation === Location.Hand) {
			throw new Error('Cannot move champion to hand');
		}

		if (data.targetLocation === Location.JungleTop || data.targetLocation === Location.JungleBot) {
			throw new Error('Jungles not yet implemented')
		}

		if (champ.getLocation() !== Location.Hand && champ.getLocation() !== Location.LaneMid && data.targetLocation !== Location.LaneMid) {
			throw new Error('Cannot move more than one lane over');
		}

		update.newChamps = [];

		// Draw a new champion to the hand
		if (champ.getLocation() === Location.Hand) {
			let drawnChamp = player.getDeck().drawChampion(player.getId());
			this.activeChamps[drawnChamp.getUid()] = drawnChamp;
			update.newChamps.push(drawnChamp);
		}

		update.moved = [];

		champ.setLocation(data.targetLocation);
		update.moved.push({
			uid: champ.getUid(),
			location: champ.getLocation()
		});

	}

	private gameOver(player: Player): void {
		console.log('game over: winner is ' + player.getId());
	}
}

export enum GameState {
	None,  // do not use
	Waiting,
	NotStarted,
	Started,
	Over
}

export class Player {
	private id: string;
	private sock: SocketIO.Socket;
	private health: number;
	private deck: Deck;
	private invulnTurn: number;
	private fountain: {championId: number, championLevel: number, deathTimer: number}[];

	private ready: boolean;

	constructor(playerId: string, sock: SocketIO.Socket) {
		this.id = playerId;
		this.sock = sock;
		this.health = 10;
		this.deck = null;
		this.ready = false;
		this.invulnTurn = 3;
		this.fountain = [];
	}

	public getSocket(): SocketIO.Socket {
		return this.sock;
	}

	public getId(): string {
		return this.id;
	}

	public getDeck(): Deck {
		return this.deck;
	}

	public setDeck(d: Deck): void {
		this.deck = d;
		this.ready = true;
	}

	public isReady(): boolean {
		return this.ready;
	}

	public initializeHand(count: number, activeChamps: any): void {
		for (let i = 0; i < count; i++) {
			let c = this.deck.drawChampion(this.id);
			activeChamps[c.getUid()] = c;
		}
	}

	public getHealth(): number {
		return this.health;
	}

	public getInvulnTurn(): number {
		return this.invulnTurn;
	}

	/** Returns true if health is 0 */
	public applyDamage(dmg: number): boolean {
		this.health -= Math.min(dmg, this.health);
		return this.health === 0;
	}

	public tickFountain(): void {
		for (let i = 0; i < this.fountain.length; i++) {
			let curr = this.fountain[i];
			curr.deathTimer--;
			if (curr.deathTimer === 0) {
				this.fountain.splice(i, 1);
				this.deck.addChampion(curr.championId, curr.championLevel);
			}
		}
	}

	/** */
	public sendToFountain(champ: Champion) {
		this.fountain.push({
			championId: champ.getChampId(),
			championLevel: champ.getChampLevel(),
			deathTimer: 5
		});
	}
}

export class Champion {
	private champId: number;
	private uid: string;
	private champLevel: number;
	private owner: string;
	private health: number;
	private dmg: number;
	private ability: Ability;
	private currentLocation: Location;
	private stunnedTurn: number;
	private invulnTurn: number;

	constructor(owner: string, champId: number, champLevel: number) {
		this.uid = generateId(8);
		this.champId = champId;
		this.champLevel = champLevel; this.owner = owner;
		this.owner = owner;
		this.health = 5;
		this.dmg = 3;
		this.currentLocation = Location.Hand;
		this.stunnedTurn = 0;
		this.invulnTurn = 0;
	}

	/** Return true if enemy is killed */
	public attackEnemy(enemy: Champion): boolean {
		enemy.health -= Math.min(this.dmg, enemy.health);
		return enemy.health === 0;
	}

	public getHealth(): number {
		return this.health;
	}

	public getDamage(): number {
		return this.dmg;
	}

	public getChampId(): number {
		return this.champId;
	}

	public getChampLevel(): number {
		return this.champLevel;
	}

	public getUid(): string {
		return this.uid;
	}

	public getLocation(): Location {
		return this.currentLocation;
	}

	public setLocation(loc: Location): void {
		this.currentLocation = loc;
	}

	public getOwner(): string {
		return this.owner;
	}

	public getStunnedTurn(): number {
		return this.stunnedTurn;
	}

	public getInvulnTurn(): number {
		return this.invulnTurn;
	}
}

export interface Ability {
	effect: (context: any) => void;
	readyTurn: number;  // cooldown; when game.turnNum >= readyTurn, ability can be used
}

export enum Location {
	None, // Do not use
	Hand,
	LaneTop,
	LaneMid,
	LaneBot,
	JungleTop,
	JungleBot
}

export class Deck {
	private summonerName: string;
	private summonerId: string;
	private champions: {championId: number, championLevel: number}[];

	constructor(summonerName: string, summonerId: number) {
		this.summonerName = summonerName;
		this.champions = [];
	}

	public static createDeck(summonerName: string, rawData: any): Deck {
		if (!rawData.length || rawData.length === 0) {
			return null;
		}

		let resultDeck = new Deck(summonerName, rawData[0].playerId);
		for (let i = 0; i < rawData.length; i++) {
			resultDeck.addChampion(rawData[i].championId, rawData[i].championLevel);
		}
		return resultDeck;
	}

	public addChampion(championId: number, championLevel: number): void {
		this.champions.push({
			championId: championId,
			championLevel: championLevel
		});
	}

	public drawChampion(playerId: string): Champion {
		let champRaw = this.champions.splice(Math.floor(this.champions.length * Math.random()), 1)[0];
		return new Champion(playerId, champRaw.championId, champRaw.championLevel);
	}
}
