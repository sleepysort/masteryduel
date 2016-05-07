export interface Dictionary<T> {
	[key: string]: T
}

export interface ChampionDto {
	id: number,
	title: string,
	name: string,
	key: string
}

export interface Style {
	isActive: boolean;
	isSource?: boolean;
	isControl?: boolean;
}

export interface Wrapper<T> {
	value: T;
}

/**
* Represents the various stages of the game
*/
export enum GameState {
	/** DO NOT USE */
	None,
	/** Not enough players to begin */
	Waiting,
	/** Players are picking their decks */
	NotStarted,
	/** Game is in progress */
	Started,
	/** Game is over */
	Over
}
