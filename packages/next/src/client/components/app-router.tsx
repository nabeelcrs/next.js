'use client'

import type { ReactNode } from 'react'
import React, {
  use,
  useEffect,
  useMemo,
  useCallback,
  startTransition,
  useInsertionEffect,
} from 'react'
import {
  AppRouterContext,
  LayoutRouterContext,
  GlobalLayoutRouterContext,
  CacheStates,
} from '../../shared/lib/app-router-context'
import type {
  CacheNode,
  AppRouterInstance,
} from '../../shared/lib/app-router-context'
import type {
  FlightRouterState,
  FlightData,
} from '../../server/app-render/types'
import type { ErrorComponent } from './error-boundary'
import { reducer } from './router-reducer/router-reducer'
import {
  ACTION_FAST_REFRESH,
  ACTION_NAVIGATE,
  ACTION_PREFETCH,
  ACTION_REFRESH,
  ACTION_RESTORE,
  ACTION_SERVER_ACTION,
  ACTION_SERVER_PATCH,
  PrefetchKind,
  ReducerActions,
  RouterChangeByServerResponse,
  RouterNavigate,
  ServerActionDispatcher,
} from './router-reducer/router-reducer-types'
import { createHrefFromUrl } from './router-reducer/create-href-from-url'
import {
  SearchParamsContext,
  PathnameContext,
} from '../../shared/lib/hooks-client-context'
import { useReducerWithReduxDevtools } from './use-reducer-with-devtools'
import { ErrorBoundary } from './error-boundary'
import {
  createInitialRouterState,
  InitialRouterStateParameters,
} from './router-reducer/create-initial-router-state'
import { isBot } from '../../shared/lib/router/utils/is-bot'
import { addBasePath } from '../add-base-path'
import { AppRouterAnnouncer } from './app-router-announcer'
import { RedirectBoundary } from './redirect-boundary'
import { NotFoundBoundary } from './not-found-boundary'
import { findHeadInCache } from './router-reducer/reducers/find-head-in-cache'
import { createInfinitePromise } from './infinite-promise'
import { NEXT_RSC_UNION_QUERY } from './app-router-headers'

const isServer = typeof window === 'undefined'

// Ensure the initialParallelRoutes are not combined because of double-rendering in the browser with Strict Mode.
let initialParallelRoutes: CacheNode['parallelRoutes'] = isServer
  ? null!
  : new Map()

let globalServerActionDispatcher = null as ServerActionDispatcher | null

export function getServerActionDispatcher() {
  return globalServerActionDispatcher
}

export function urlToUrlWithoutFlightMarker(url: string): URL {
  const urlWithoutFlightParameters = new URL(url, location.origin)
  urlWithoutFlightParameters.searchParams.delete(NEXT_RSC_UNION_QUERY)
  if (process.env.NODE_ENV === 'production') {
    if (process.env.__NEXT_CONFIG_OUTPUT === 'export') {
      if (urlWithoutFlightParameters.pathname.endsWith('/index.txt')) {
        // Slice off `/index.txt` from the end of the pathname
        urlWithoutFlightParameters.pathname =
          urlWithoutFlightParameters.pathname.slice(0, -`/index.txt`.length)
      } else {
        // Slice off `.txt` from the end of the pathname
        urlWithoutFlightParameters.pathname =
          urlWithoutFlightParameters.pathname.slice(0, -`.txt`.length)
      }
    }
  }
  return urlWithoutFlightParameters
}

const HotReloader:
  | typeof import('./react-dev-overlay/hot-reloader-client').default
  | null =
  process.env.NODE_ENV === 'production'
    ? null
    : (require('./react-dev-overlay/hot-reloader-client')
        .default as typeof import('./react-dev-overlay/hot-reloader-client').default)

type AppRouterProps = Omit<
  Omit<InitialRouterStateParameters, 'isServer' | 'location'>,
  'initialParallelRoutes'
> & {
  buildId: string
  initialHead: ReactNode
  assetPrefix: string
  // Top level boundaries props
  notFound: React.ReactNode | undefined
  asNotFound?: boolean
}

function isExternalURL(url: URL) {
  return url.origin !== window.location.origin
}

function HistoryUpdater({ tree, pushRef, canonicalUrl, sync }: any) {
  useInsertionEffect(() => {
    // Identifier is shortened intentionally.
    // __NA is used to identify if the history entry can be handled by the app-router.
    // __N is used to identify if the history entry can be handled by the old router.
    const historyState = {
      __NA: true,
      tree,
    }
    if (
      pushRef.pendingPush &&
      createHrefFromUrl(new URL(window.location.href)) !== canonicalUrl
    ) {
      // This intentionally mutates React state, pushRef is overwritten to ensure additional push/replace calls do not trigger an additional history entry.
      pushRef.pendingPush = false
      window.history.pushState(historyState, '', canonicalUrl)
    } else {
      window.history.replaceState(historyState, '', canonicalUrl)
    }
    sync()
  }, [tree, pushRef, canonicalUrl, sync])
  return null
}

const createEmptyCacheNode = () => ({
  status: CacheStates.LAZY_INITIALIZED,
  data: null,
  subTreeData: null,
  parallelRoutes: new Map(),
})

function useServerActionDispatcher(
  changeByServerResponse: RouterChangeByServerResponse,
  dispatch: React.Dispatch<ReducerActions>,
  navigate: RouterNavigate
) {
  const serverActionDispatcher: ServerActionDispatcher = useCallback(
    (actionPayload) => {
      startTransition(() => {
        dispatch({
          ...actionPayload,
          type: ACTION_SERVER_ACTION,
          mutable: {},
          navigate,
          changeByServerResponse,
        })
      })
    },
    [changeByServerResponse, dispatch, navigate]
  )
  globalServerActionDispatcher = serverActionDispatcher
}

/**
 * Server response that only patches the cache and tree.
 */
function useChangeByServerResponse(
  dispatch: React.Dispatch<ReducerActions>
): RouterChangeByServerResponse {
  return useCallback(
    (
      previousTree: FlightRouterState,
      flightData: FlightData,
      overrideCanonicalUrl: URL | undefined
    ) => {
      startTransition(() => {
        dispatch({
          type: ACTION_SERVER_PATCH,
          flightData,
          previousTree,
          overrideCanonicalUrl,
          cache: createEmptyCacheNode(),
          mutable: {},
        })
      })
    },
    [dispatch]
  )
}

function useNavigate(dispatch: React.Dispatch<ReducerActions>): RouterNavigate {
  return useCallback(
    (href, navigateType, forceOptimisticNavigation, shouldScroll) => {
      const url = new URL(addBasePath(href), location.href)

      return dispatch({
        type: ACTION_NAVIGATE,
        url,
        isExternalUrl: isExternalURL(url),
        locationSearch: location.search,
        forceOptimisticNavigation,
        shouldScroll: shouldScroll ?? true,
        navigateType,
        cache: createEmptyCacheNode(),
        mutable: {},
      })
    },
    [dispatch]
  )
}

/**
 * The global router that wraps the application components.
 */
function Router({
  buildId,
  initialHead,
  initialTree,
  initialCanonicalUrl,
  children,
  assetPrefix,
  notFound,
  asNotFound,
}: AppRouterProps) {
  const initialState = useMemo(
    () =>
      createInitialRouterState({
        buildId,
        children,
        initialCanonicalUrl,
        initialTree,
        initialParallelRoutes,
        isServer,
        location: !isServer ? window.location : null,
        initialHead,
      }),
    [buildId, children, initialCanonicalUrl, initialTree, initialHead]
  )
  const [
    {
      tree,
      cache,
      prefetchCache,
      pushRef,
      focusAndScrollRef,
      canonicalUrl,
      nextUrl,
    },
    dispatch,
    sync,
  ] = useReducerWithReduxDevtools(reducer, initialState)

  useEffect(() => {
    // Ensure initialParallelRoutes is cleaned up from memory once it's used.
    initialParallelRoutes = null!
  }, [])

  // Add memoized pathname/query for useSearchParams and usePathname.
  const { searchParams, pathname } = useMemo(() => {
    const url = new URL(
      canonicalUrl,
      typeof window === 'undefined' ? 'http://n' : window.location.href
    )

    return {
      // This is turned into a readonly class in `useSearchParams`
      searchParams: url.searchParams,
      pathname: url.pathname,
    }
  }, [canonicalUrl])

  const changeByServerResponse = useChangeByServerResponse(dispatch)
  const navigate = useNavigate(dispatch)
  useServerActionDispatcher(changeByServerResponse, dispatch, navigate)

  /**
   * The app router that is exposed through `useRouter`. It's only concerned with dispatching actions to the reducer, does not hold state.
   */
  const appRouter = useMemo<AppRouterInstance>(() => {
    const routerInstance: AppRouterInstance = {
      back: () => window.history.back(),
      forward: () => window.history.forward(),
      prefetch: (href, options) => {
        // If prefetch has already been triggered, don't trigger it again.
        if (isBot(window.navigator.userAgent)) {
          return
        }
        const url = new URL(addBasePath(href), location.href)
        // External urls can't be prefetched in the same way.
        if (isExternalURL(url)) {
          return
        }
        startTransition(() => {
          dispatch({
            type: ACTION_PREFETCH,
            url,
            kind: options?.kind ?? PrefetchKind.FULL,
          })
        })
      },
      replace: (href, options = {}) => {
        startTransition(() => {
          navigate(
            href,
            'replace',
            Boolean(options.forceOptimisticNavigation),
            options.scroll ?? true
          )
        })
      },
      push: (href, options = {}) => {
        startTransition(() => {
          navigate(
            href,
            'push',
            Boolean(options.forceOptimisticNavigation),
            options.scroll ?? true
          )
        })
      },
      refresh: () => {
        startTransition(() => {
          dispatch({
            type: ACTION_REFRESH,
            cache: createEmptyCacheNode(),
            mutable: {},
            origin: window.location.origin,
          })
        })
      },
      // @ts-ignore we don't want to expose this method at all
      fastRefresh: () => {
        if (process.env.NODE_ENV !== 'development') {
          throw new Error(
            'fastRefresh can only be used in development mode. Please use refresh instead.'
          )
        } else {
          startTransition(() => {
            dispatch({
              type: ACTION_FAST_REFRESH,
              cache: createEmptyCacheNode(),
              mutable: {},
              origin: window.location.origin,
            })
          })
        }
      },
    }

    return routerInstance
  }, [dispatch, navigate])

  useEffect(() => {
    // Exists for debugging purposes. Don't use in application code.
    if (window.next) {
      window.next.router = appRouter
    }
  }, [appRouter])

  if (process.env.NODE_ENV !== 'production') {
    // This hook is in a conditional but that is ok because `process.env.NODE_ENV` never changes
    // eslint-disable-next-line react-hooks/rules-of-hooks
    useEffect(() => {
      // Add `window.nd` for debugging purposes.
      // This is not meant for use in applications as concurrent rendering will affect the cache/tree/router.
      // @ts-ignore this is for debugging
      window.nd = {
        router: appRouter,
        cache,
        prefetchCache,
        tree,
      }
    }, [appRouter, cache, prefetchCache, tree])
  }

  // When mpaNavigation flag is set do a hard navigation to the new url.
  // Infinitely suspend because we don't actually want to rerender any child
  // components with the new URL and any entangled state updates shouldn't
  // commit either (eg: useTransition isPending should stay true until the page
  // unloads).
  //
  // This is a side effect in render. Don't try this at home, kids. It's
  // probably safe because we know this is a singleton component and it's never
  // in <Offscreen>. At least I hope so. (It will run twice in dev strict mode,
  // but that's... fine?)
  if (pushRef.mpaNavigation) {
    const location = window.location
    if (pushRef.pendingPush) {
      location.assign(canonicalUrl)
    } else {
      location.replace(canonicalUrl)
    }
    // TODO-APP: Should we listen to navigateerror here to catch failed
    // navigations somehow? And should we call window.stop() if a SPA navigation
    // should interrupt an MPA one?
    use(createInfinitePromise())
  }

  /**
   * Handle popstate event, this is used to handle back/forward in the browser.
   * By default dispatches ACTION_RESTORE, however if the history entry was not pushed/replaced by app-router it will reload the page.
   * That case can happen when the old router injected the history entry.
   */
  const onPopState = useCallback(
    ({ state }: PopStateEvent) => {
      if (!state) {
        // TODO-APP: this case only happens when pushState/replaceState was called outside of Next.js. It should probably reload the page in this case.
        return
      }

      // This case happens when the history entry was pushed by the `pages` router.
      if (!state.__NA) {
        window.location.reload()
        return
      }

      // @ts-ignore useTransition exists
      // TODO-APP: Ideally the back button should not use startTransition as it should apply the updates synchronously
      // Without startTransition works if the cache is there for this path
      startTransition(() => {
        dispatch({
          type: ACTION_RESTORE,
          url: new URL(window.location.href),
          tree: state.tree,
        })
      })
    },
    [dispatch]
  )

  // Register popstate event to call onPopstate.
  useEffect(() => {
    window.addEventListener('popstate', onPopState)
    return () => {
      window.removeEventListener('popstate', onPopState)
    }
  }, [onPopState])

  const head = useMemo(() => {
    return findHeadInCache(cache, tree[1])
  }, [cache, tree])

  const notFoundProps = { notFound, asNotFound }

  const content = (
    <RedirectBoundary>
      {head}
      {cache.subTreeData}
      <AppRouterAnnouncer tree={tree} />
    </RedirectBoundary>
  )

  return (
    <>
      <HistoryUpdater
        tree={tree}
        pushRef={pushRef}
        canonicalUrl={canonicalUrl}
        sync={sync}
      />
      <PathnameContext.Provider value={pathname}>
        <SearchParamsContext.Provider value={searchParams}>
          <GlobalLayoutRouterContext.Provider
            value={{
              buildId,
              changeByServerResponse,
              tree,
              focusAndScrollRef,
              nextUrl,
            }}
          >
            <AppRouterContext.Provider value={appRouter}>
              <LayoutRouterContext.Provider
                value={{
                  childNodes: cache.parallelRoutes,
                  tree: tree,
                  // Root node always has `url`
                  // Provided in AppTreeContext to ensure it can be overwritten in layout-router
                  url: canonicalUrl,
                }}
              >
                {HotReloader ? (
                  // HotReloader implements a separate NotFoundBoundary to maintain the HMR ping interval
                  <HotReloader assetPrefix={assetPrefix} {...notFoundProps}>
                    {content}
                  </HotReloader>
                ) : (
                  <NotFoundBoundary {...notFoundProps}>
                    {content}
                  </NotFoundBoundary>
                )}
              </LayoutRouterContext.Provider>
            </AppRouterContext.Provider>
          </GlobalLayoutRouterContext.Provider>
        </SearchParamsContext.Provider>
      </PathnameContext.Provider>
    </>
  )
}

export default function AppRouter(
  props: AppRouterProps & { globalErrorComponent: ErrorComponent }
) {
  const { globalErrorComponent, ...rest } = props

  return (
    <ErrorBoundary errorComponent={globalErrorComponent}>
      <Router {...rest} />
    </ErrorBoundary>
  )
}
