export enum Tag {
	System,
	Error,
	Network,
	Game
}

/**
* Use to log detailed messages to the server
*/
export function log(tag: Tag, message: string, gameId?: string): void {
	console.log((new Date()).toString() + ' [' + Tag[tag] + (tag === Tag.Game ? ':' +  gameId : '') + '] ' + message);
}
