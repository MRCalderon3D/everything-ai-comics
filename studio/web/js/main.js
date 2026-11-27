// Entry point: theme, language, the shell, the routes.

import { setLang, localLanguage, onLangChange } from '/js/i18n.js';
import { applyTheme, loadHealth, bus } from '/js/store.js';
import { route, start, rerender } from '/js/router.js';
import { startShell, paintShell } from '/js/shell.js';
import { startJobs } from '/js/components/jobs.js';
import { startConversation } from '/js/components/conversation.js';
import { startLayout } from '/js/layout.js';
import { startUnseen } from '/js/unseen.js';

applyTheme();
setLang(localLanguage());

route('/', () => import('/js/screens/projects.js'), { screen: 'projects' });
route('/new', () => import('/js/screens/new-project.js'), { screen: 'projects' });
route('/settings', () => import('/js/screens/settings.js'), { screen: 'settings' });
route('/p/:id', () => import('/js/screens/home.js'), { screen: 'home' });
route('/p/:id/story', () => import('/js/screens/story.js'), { screen: 'story' });
route('/p/:id/style', () => import('/js/screens/style.js'), { screen: 'style' });
route('/p/:id/characters', () => import('/js/screens/characters.js'), { screen: 'characters' });
route('/p/:id/characters/:char', () => import('/js/screens/character.js'), { screen: 'characters' });
route('/p/:id/places', () => import('/js/screens/places.js'), { screen: 'places' });
route('/p/:id/places/:kind/:entity', () => import('/js/screens/place.js'), { screen: 'places' });
route('/p/:id/pages', () => import('/js/screens/pages.js'), { screen: 'pages' });
route('/p/:id/pages/:page', () => import('/js/screens/page.js'), { screen: 'pages' });
route('/p/:id/check', () => import('/js/screens/check.js'), { screen: 'check' });
route('/p/:id/check/:page', () => import('/js/screens/check.js'), { screen: 'check' });
route('/p/:id/corrections', () => import('/js/screens/corrections.js'), { screen: 'corrections' });
route('/p/:id/corrections/:page', () => import('/js/screens/corrections.js'), { screen: 'corrections' });
route('/p/:id/cover', () => import('/js/screens/cover.js'), { screen: 'cover' });
route('/p/:id/publish', () => import('/js/screens/publish.js'), { screen: 'publish' });
route('/p/:id/history', () => import('/js/screens/history.js'), { screen: 'history' });
route('/p/:id/settings', () => import('/js/screens/settings.js'), { screen: 'settings' });
route('/p/:id/decisions', () => import('/js/screens/decisions.js'), { screen: 'decisions' });

let langTimer = null;
onLangChange(() => {
  // The language can change while a screen is loading (a project sets it).
  clearTimeout(langTimer);
  langTimer = setTimeout(() => {
    paintShell();
    bus.emit('repaint');
    rerender();
  }, 0);
});

startLayout();
startUnseen();
startShell();
startConversation();
startJobs();
loadHealth().catch(() => {});
start();
