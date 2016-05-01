import md = require('./game');

export class GamesManager {
	private static currentInstance: GamesManager;

	private games: { [gameId: string]: md.Game };

	public static getInstance(): GamesManager {
		if (!GamesManager.currentInstance) {
			GamesManager.currentInstance = new GamesManager();
		}
		return GamesManager.currentInstance;
	}

	/** Do not use */
	constructor() {
		this.games = {};
	}

	public getGame(gameId: string): md.Game {
		return this.games[gameId];
	}

	public addGame(): string {
		let newGameId = md.generateId(12);
		let newGame = new md.Game(this, newGameId);
		this.games[newGameId] = newGame;
		return newGameId;
	}

	public removeGame(gameId: string): void {
		console.log('game ' + gameId + ' deleted');
		delete this.games[gameId];
	}
}
