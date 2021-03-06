/* eslint-disable camelcase */
/** @typedef {import('../../types').ICtxBase} ICtxBase */
import * as util from '../../support/util';
import * as cst from '../../support/constant';
import { NOT_A_JSON } from '../../support/priv-constant';
import runLater from '../base/run-later';
import ccContext from '../../cc-context';
import extractStateByKeys from '../state/extract-state-by-keys';
import watchKeyForRef from '../watch/watch-key-for-ref';
import computeValueForRef from '../computed/compute-value-for-ref';
import findUpdateRefs from '../ref/find-update-refs';
import { send } from '../plugin';

const { isPJO, justWarning, isObjectNull, computeFeature, okeys } = util;
const {
  FOR_CUR_MOD, FOR_ANOTHER_MOD,
  FORCE_UPDATE, SET_STATE,
  SIG_STATE_CHANGED,
  RENDER_NO_OP, RENDER_BY_KEY, RENDER_BY_STATE,
  UNMOUNTED, MOUNTED,
} = cst;
const {
  store: { setState: storeSetState, getPrevState, saveSharedState }, middlewares, ccClassKey2Context,
  refStore, getModuleStateKeys,
} = ccContext;

// 触发修改状态的实例所属模块和目标模块不一致的时候，stateFor是 FOR_ANOTHER_MOD
function getStateFor(targetModule, refModule) {
  return targetModule === refModule ? FOR_CUR_MOD : FOR_ANOTHER_MOD;
}

function callMiddlewares(skipMiddleware, passToMiddleware, cb) {
  if (skipMiddleware !== true) {
    const len = middlewares.length;
    if (len > 0) {
      let index = 0;
      const next = () => {
        if (index === len) {// all middlewares been executed
          cb();
        } else {
          const middlewareFn = middlewares[index];
          index++;
          if (typeof middlewareFn === 'function') middlewareFn(passToMiddleware, next);
          else {
            justWarning(`found one middleware is not a function`);
            next();
          }
        }
      }
      next();
    } else {
      cb();
    }
  } else {
    cb();
  }
}

/**
 * 修改状态入口函数
 */
export default function (state, {
  module, skipMiddleware = false, payload, stateChangedCb,
  reactCallback, type, calledBy = SET_STATE, fnName = '', renderKey, delay = -1 } = {}, targetRef
) {
  if (state === undefined) return;

  if (!isPJO(state)) {
    justWarning(`your committed state ${NOT_A_JSON}`);
    return;
  }

  const targetRenderKey = util.extractRenderKey(renderKey);
  const targetDelay = (renderKey && renderKey.delay) ? renderKey.delay : delay;

  const { module: refModule, ccUniqueKey, ccKey } = targetRef.ctx;
  const stateFor = getStateFor(module, refModule);
  const callInfo = { calledBy, payload, renderKey: targetRenderKey, ccKey, module, fnName };

  // 在triggerReactSetState之前把状态存储到store，
  // 防止属于同一个模块的父组件套子组件渲染时，父组件修改了state，子组件初次挂载是不能第一时间拿到state
  // const passedRef = stateFor === FOR_CUR_MOD ? targetRef : null;
  // 标记noSave为true，延迟到后面可能存在的中间件执行结束后才save
  const {
    partialState: sharedState, hasDelta, hasPrivState
  } = syncCommittedStateToStore(module, state, { ref: targetRef, callInfo, noSave: true });

  if (hasDelta) {
    Object.assign(state, sharedState);
  }
  // 不包含私有状态，仅包含模块状态，交给belongRefs那里去触发渲染，这样可以让已失去依赖的当前实例减少一次渲染
  // 因为belongRefs那里是根据有无依赖来确定要不要渲染，这样的话如果失去了依赖不把它查出来就不触发它渲染了
  const ignoreRender = !hasPrivState && !!sharedState;

  // source ref will receive the whole committed state 
  triggerReactSetState(targetRef, callInfo, targetRenderKey, calledBy, state, stateFor, ignoreRender, reactCallback,
    // committedState means final committedState
    (renderType, committedState, updateRef) => {
      const passToMiddleware = {
        calledBy, type, payload, renderKey: targetRenderKey, targetDelay, ccKey, ccUniqueKey,
        committedState, refModule, module, fnName,
        sharedState: sharedState || {}, // 给一个空壳对象，防止用户直接用的时候报错null
      };

      // 修改或新增状态值
      // 修改并不会再次触发compute&watch过程，请明确你要修改的目的
      passToMiddleware.modState = (key, val) => {
        passToMiddleware.committedState[key] = val;
        passToMiddleware.sharedState[key] = val;
      };

      callMiddlewares(skipMiddleware, passToMiddleware, () => {
        // 到这里才触发调用saveSharedState存储模块状态和updateRef更新调用实例，注这两者前后顺序不能调换
        // 因为updateRef里的beforeRender需要把最新的模块状态合进来
        // 允许在中间件过程中使用「modState」修改某些key的值，会影响到实例的更新结果，且不会再触发computed&watch
        // 调用此接口请明确知道后果,
        // 注不要直接修改sharedState或committedState，两个对象一起修改某个key才是正确的
        const realShare = saveSharedState(module, passToMiddleware.sharedState, true);

        // TODO: 查看其它模块的cu函数里读取了当前模块的state或computed作为输入产生了的新的计算结果
        // 然后做相应的关联更新 {'$$global/key1': {foo: ['cuKey1', 'cuKey2'] } }
        // code here

        // 执行完毕所有的中间件，才更新触发调用的源头实例
        updateRef && updateRef();

        if (renderType === RENDER_NO_OP && !realShare) {
          // do nothing
        } else {
          send(SIG_STATE_CHANGED, {
            calledBy, type, committedState, sharedState: realShare || {},
            module, ccUniqueKey, renderKey: targetRenderKey
          });
        }

        // 无论是否真的有状态改变，此回调都会被触发
        if (stateChangedCb) stateChangedCb();

        // 当前上下文的ignoreRender 为true 等效于这里的入参 allowOriInsRender 为true，允许查询出oriIns后触发它渲染
        if (realShare) triggerBroadcastState(
          stateFor, callInfo, targetRef, realShare, ignoreRender, module, reactCallback, targetRenderKey, targetDelay
        );
      });
    }
  );
}

function triggerReactSetState(
  targetRef, callInfo, renderKeys, calledBy, state, stateFor, ignoreRender, reactCallback, next
) {
  const nextNoop = () => next && next(RENDER_NO_OP, state);
  const refCtx = targetRef.ctx;
  const refState = refCtx.unProxyState;

  if (ignoreRender) {
    return nextNoop();
  }

  if (
    targetRef.__$$ms === UNMOUNTED  // 已卸载
    || stateFor !== FOR_CUR_MOD
    // 确保forceUpdate能够刷新cc实例，因为state可能是{}，此时用户调用forceUpdate也要触发render
    || (calledBy !== FORCE_UPDATE && isObjectNull(state))
  ) {
    return nextNoop();
  }

  const { module: stateModule, storedKeys, ccUniqueKey } = refCtx;
  let renderType = RENDER_BY_STATE;

  if (renderKeys.length) {// if user specify renderKeys
    renderType = RENDER_BY_KEY;
    if (renderKeys.includes(refCtx.renderKey)) {
      // current instance can been rendered only if ctx.renderKey included in renderKeys
      return nextNoop();
    }
  }

  if (storedKeys.length > 0) {
    const { partialState, isStateEmpty } = extractStateByKeys(state, storedKeys);
    if (!isStateEmpty) {
      if (refCtx.persistStoredKeys === true) {
        const { partialState: entireStoredState } = extractStateByKeys(refState, storedKeys);
        const currentStoredState = Object.assign({}, entireStoredState, partialState);
        if (ccContext.localStorage) {
          ccContext.localStorage.setItem(`CCSS_${ccUniqueKey}`, JSON.stringify(currentStoredState));
        }
      }
      refStore.setState(ccUniqueKey, partialState);
    }
  }

  const deltaCommittedState = Object.assign({}, state);
  computeValueForRef(targetRef, stateModule, refState, deltaCommittedState, callInfo);
  watchKeyForRef(targetRef, stateModule, refState, deltaCommittedState, callInfo);

  const ccSetState = () => {
    // 使用 unProxyState ，避免触发get
    const changedState = util.extractChangedState(refCtx.unProxyState, deltaCommittedState)

    if (changedState) {
      // 记录stateKeys，方便triggerRefEffect之用
      refCtx.__$$settedList.push({ module: stateModule, keys: okeys(changedState) });
      refCtx.__$$ccSetState(changedState, reactCallback);
    }
  }

  if (next) {
    next(renderType, deltaCommittedState, ccSetState);
  } else {
    ccSetState();
  }
}

function syncCommittedStateToStore(moduleName, committedState, options) {
  const stateKeys = getModuleStateKeys(moduleName);

  // extract shared state
  const { partialState, missKeyInState: hasPrivState } = extractStateByKeys(committedState, stateKeys, true);

  // save state to store
  if (partialState) {
    const { hasDelta, deltaCommittedState } = storeSetState(moduleName, partialState, options);
    return { partialState: deltaCommittedState, hasDelta, hasPrivState };
  }

  return { partialState, hasDelta: false, hasPrivState };
}

function triggerBroadcastState(
  stateFor, callInfo, targetRef, sharedState, allowOriInsRender, moduleName, reactCallback, renderKeys, delay
) {
  let passAllowOri = allowOriInsRender;
  if (delay > 0) {
    if (passAllowOri) {// 优先将当前实例渲染了
      triggerReactSetState(targetRef, callInfo, [], SET_STATE, sharedState, stateFor, false, reactCallback);
    }
    passAllowOri = false;// 置为false，后面的runLater里不会再次触发当前实例渲染
  }

  const startBroadcastState = () => {
    broadcastState(callInfo, targetRef, sharedState, passAllowOri, moduleName, reactCallback, renderKeys);
  };

  if (delay > 0) {
    const feature = computeFeature(targetRef.ctx.ccUniqueKey, sharedState);
    runLater(startBroadcastState, feature, delay);
  } else {
    startBroadcastState();
  }
}

function broadcastState(callInfo, targetRef, partialSharedState, allowOriInsRender, moduleName, reactCallback, renderKeys) {
  if (!partialSharedState) {// null
    return;
  }
  const ccUKey2ref = ccContext.ccUKey2ref;

  /** @type ICtxBase */
  const { ccUniqueKey: currentCcUKey, ccClassKey } = targetRef.ctx;
  const renderKeyClasses = ccClassKey2Context[ccClassKey].renderKeyClasses;

  const {
    sharedStateKeys, result: { belong: belongRefKeys, connect: connectRefKeys }
  } = findUpdateRefs(moduleName, partialSharedState, renderKeys, renderKeyClasses);

  const renderedInBelong = {};
  belongRefKeys.forEach(refKey => {
    const ref = ccUKey2ref[refKey];
    if (!ref) return;
    const refUKey = ref.ctx.ccUniqueKey;

    let rcb = null;
    // 这里的calledBy直接用'broadcastState'，仅供concent内部运行时用
    let calledBy = 'broadcastState';
    if (refUKey === currentCcUKey) {
      if (!allowOriInsRender) return;
      rcb = reactCallback;
      calledBy = callInfo.calledBy;
    }
    triggerReactSetState(ref, callInfo, [], calledBy, partialSharedState, FOR_CUR_MOD, false, rcb);
    renderedInBelong[refKey] = 1;
  });

  const prevModuleState = getPrevState(moduleName);
  connectRefKeys.forEach(refKey => {
    // 对于即属于又连接的实例，避免一次重复的渲染
    if (renderedInBelong[refKey]) {
      return;
    }

    const ref = ccUKey2ref[refKey];
    if (!ref) return;

    // 对于挂载好了还未卸载的实例，才有必要触发重渲染
    if (ref.__$$ms === MOUNTED) {
      const refCtx = ref.ctx;
      const {
        hasDelta: hasDeltaInCu, newCommittedState: cuCommittedState,
      } = computeValueForRef(ref, moduleName, prevModuleState, partialSharedState, callInfo, false, false);
      const {
        hasDelta: hasDeltaInWa, newCommittedState: waCommittedState,
      } = watchKeyForRef(ref, moduleName, prevModuleState, partialSharedState, callInfo, false, false);

      // computed & watch 过程中提交了新的state，合并到 unProxyState 里
      // 注意这里，computeValueForRef watchKeyForRef 调用的 findDepFnsToExecute内部
      // 保证了实例里cu或者wa函数commit提交的状态只能是 privateStateKey，所以合并到unProxyState是安全的
      if (hasDeltaInCu || hasDeltaInWa) {
        const changedRefPrivState = Object.assign(cuCommittedState, waCommittedState);
        const refModule = refCtx.module;
        const refState = refCtx.unProxyState;

        computeValueForRef(ref, refModule, refState, changedRefPrivState, callInfo);
        watchKeyForRef(ref, refModule, refState, changedRefPrivState, callInfo);

        Object.assign(refState, changedRefPrivState);
        Object.assign(refCtx.state, changedRefPrivState);
        refCtx.__$$settedList.push({ module: refModule, keys: okeys(changedRefPrivState) });
      }

      // 记录sharedStateKeys，方便triggerRefEffect之用
      refCtx.__$$settedList.push({ module: moduleName, keys: sharedStateKeys });
      refCtx.__$$ccForceUpdate();
    }
  });
}
