import I = require('./interfaces');

export class statcomputer {

  public static getHealth(primary: I.ChampionTag, secondary: I.ChampionTag, champLevel: number): number {
    return this.compStats(primary, secondary, champLevel, 'health');
  }

  public static getDamage(primary: I.ChampionTag, secondary: I.ChampionTag, champLevel: number): number {
    return this.compStats(primary, secondary, champLevel, 'dmg');
  }

  private static getStatByTag(tag: I.ChampionTag, index: number): number {
    // baseHealth, healthScale, baseDmg, dmgScale
    var stats = [12, 1.2, 3, 1.2];
    if (tag === I.ChampionTag.Assassin) {
      stats = [12, 1.1, 7, 1.4];
    }
    else if (tag === I.ChampionTag.Fighter) {
      stats = [12, 1.1, 7, 1.4];
    }
    else if (tag === I.ChampionTag.Mage) {
      stats = [12, 1.3, 6, 1.3];
    }
    else if (tag === I.ChampionTag.Marksman) {
      stats = [10, 1.2, 5, 1.4];
    }
    else if (tag === I.ChampionTag.Support) {
      stats = [14, 1.1, 1, 1.0];
    }
    else if (tag === I.ChampionTag.Tank) {
      stats = [17, 1.5, 2, 1.1];
    }
    return stats[index];
  }

  private static compStats(primary: I.ChampionTag, secondary: I.ChampionTag, champLevel: number, stat: string): number {
    var index = 0;
    if (stat === 'dmg') {
      index += 2;
    }

    if (!secondary) {
      return Math.round(this.getStatByTag[primary, index] * Math.pow(this.getStatByTag[primary, index+1], champLevel));
    } else {
      return Math.round((this.getStatByTag[primary, index] * Math.pow(this.getStatByTag[primary, index+1], champLevel) +
                         this.getStatByTag[secondary, index] * Math.pow(this.getStatByTag[primary, index+1], champLevel)) / 2);
    }
  }
}
