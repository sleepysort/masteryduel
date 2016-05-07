import I = require('./interfaces');

export class StatComputer {

  public static getHealth(primary: I.ChampionTag, secondary: I.ChampionTag, champLevel: number): number {
    return this.compStats(primary, secondary, champLevel, 'health');
  }

  public static getDamage(primary: I.ChampionTag, secondary: I.ChampionTag, champLevel: number): number {
    return this.compStats(primary, secondary, champLevel, 'dmg');
  }

  private static getStatByTag(tag: I.ChampionTag, index: number): number {
    // baseHealth, healthScale, baseDmg, dmgScale
    var stats = [];
    if (tag === I.ChampionTag.Assassin) {
      stats = [16, 1.1, 8, 1.4];
    }
    else if (tag === I.ChampionTag.Fighter) {
      stats = [23, 1.4, 4, 1.2];
    }
    else if (tag === I.ChampionTag.Mage) {
      stats = [15, 1.3, 5, 1.5];
    }
    else if (tag === I.ChampionTag.Marksman) {
      stats = [15, 1.2, 7, 1.6];
    }
    else if (tag === I.ChampionTag.Support) {
      stats = [20, 1.2, 2, 1.0];
    }
    else if (tag === I.ChampionTag.Tank) {
      stats = [26, 1.5, 3, 1.1];
    }
    return stats[index];
  }

  private static compStats(primary: I.ChampionTag, secondary: I.ChampionTag, champLevel: number, stat: string): number {
    var index = 0;
    if (stat === 'dmg') {
      index += 2;
    }

    if (!secondary) {
      return Math.round(this.getStatByTag(primary, index) * Math.pow(this.getStatByTag(primary, index+1), champLevel));
    } else {
      return Math.round((this.getStatByTag(primary, index) * Math.pow(this.getStatByTag(primary, index+1), champLevel) +
                         this.getStatByTag(secondary, index) * Math.pow(this.getStatByTag(primary, index+1), champLevel)) / 2);
    }
  }
}
