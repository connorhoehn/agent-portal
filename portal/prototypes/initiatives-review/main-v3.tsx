import React from 'react';
import { createRoot } from 'react-dom/client';
import { DensityProvider } from '@connorhoehn/ui-components/shared';
import { Budget, Work, Sprints, Run, Dispatch } from './revision3';
const page=document.getElementById('review-content')!.dataset.page;
createRoot(document.getElementById('review-content')!).render(<DensityProvider density="compact">{page==='budget'?<Budget/>:page==='work'?<Work/>:page==='sprints'?<Sprints/>:page==='run'?<Run/>:<Dispatch/>}</DensityProvider>);
