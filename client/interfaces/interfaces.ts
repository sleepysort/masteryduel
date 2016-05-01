export interface Dictionary<T> {
	[key: string]: T
}

export interface ChampionDto {
	id: number,
	title: string,
	name: string,
	key: string
}
