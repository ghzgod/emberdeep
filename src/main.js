import { Game } from './game.js';

const game = new Game();
window.__game = game; // handy for debugging/tests
game.boot();
