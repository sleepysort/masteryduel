import generator = require('../util/generator');
import g = require('./game');
import Logger = require('../util/logger');

/**
* Class to handle the game instances on the server
*/
export class GamesManager {
	/** The game manager being used by the server */
	private static currentInstance: GamesManager;

	/** Dictionary of games managed by the game manager */
	private games: { [gameId: string]: g.Game };

	/**
	* @return the instance of the game manager being used by the server
	*/
	public static getInstance(): GamesManager {
		if (!GamesManager.currentInstance) {
			GamesManager.currentInstance = new GamesManager();
		}
		return GamesManager.currentInstance;
	}

	/** DO NOT USE */
	constructor() {
		this.games = {};
	}

	/**
	* @return the game with the given game id
	*/
	public getGame(gameId: string): g.Game {
		return this.games[gameId];
	}

	/**
	* Creates a new game and adds it to the game manager
	* @return the id of the game
	*/
	public addGame(): string {
		let newGameId = generator.generateId(12);
		let newGame = new g.Game(newGameId);
		this.games[newGameId] = newGame;
		Logger.log(Logger.Tag.Game, 'New game created.', newGameId);
		return newGameId;
	}

	/**
	* Removes the game with the given game id from the game manager
	* @param gameId	the id of the game to remove
	*/
	public removeGame(gameId: string): void {
		delete this.games[gameId];
		Logger.log(Logger.Tag.Game, 'Game deleted.', gameId);
	}
}
