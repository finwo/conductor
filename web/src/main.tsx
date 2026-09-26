// web/src/main.tsx - routes, and getting a token before any of them run

import m from 'mithril';
import * as auth from './util/auth';
import { ApiError, get } from './util/api';
import { Chrome, Failed, session } from './component/layout';
import { Jobs } from './screen/jobs';
import { Job } from './screen/job';
import { Task } from './screen/task';
import { Projects } from './screen/projects';
import { Project } from './screen/project';
import { Workers, Worker } from './screen/workers';
import { Users, Sessions } from './screen/users';

const root = document.body;

function wrap(screen: m.Component): m.RouteResolver {
  return { render: () => m(Chrome, m(screen)) };
}

const routes: m.RouteDefs = {
  '/jobs': wrap(Jobs),
  '/jobs/:job': wrap(Job),
  '/tasks/:task': wrap(Task),
  '/projects': wrap(Projects),
  '/projects/:project': wrap(Project),
  '/projects/:project/jobs': wrap(Jobs),
  '/workers': wrap(Workers),
  '/workers/:worker': wrap(Worker),
  '/users': wrap(Users),
  '/sessions': wrap(Sessions),
};

function fail(error: unknown) {
  m.mount(root, { view: () => m(Chrome, m(Failed, { error })) });
}

async function start() {
  let resume: string | null = null;
  try {
    resume = await auth.completeSignIn();
  } catch (e) {
    fail(e);
    return;
  }

  if (auth.signedIn()) {
    try {
      session.user = await get('/users/me');
    } catch (e) {
      if ((e as ApiError).status === 401) auth.forget();
      // Still holding a credential means the conductor itself is unhappy.
      if (auth.signedIn()) {
        fail(e);
        return;
      }
    }
  }

  m.route.prefix = '#!';
  m.route(root, '/jobs', routes);
  if (resume) m.route.set(resume.replace(/^#!/, ''));
}

start();
