import { div, svg } from 'gpui-kit';
import { h_flex, v_flex } from 'gpui-base';
import { openOverlay, closeOverlay, props, theme, notify } from 'herdr';
import { formatCode, remainingTime, connectionLabel } from './connection-state.js';
import { popoverAnchor } from './popup-layout.js';
import { bundledExtensionDir } from './format.js';
import { exec } from 'herdr';

function button(t, id, label, action, primary = false, danger = false, disabled = false) {
  return div().id(id).h(30).px(10).flex_none().flex().items_center().justify_center()
    .rounded(6).text_size(12).font_medium()
    .bg(primary ? (danger ? t.blocked : t.accent) : t.surface)
    .text_color(primary ? t.accent_foreground : danger ? t.blocked : t.foreground)
    .border(1).border_color(primary ? (danger ? t.blocked : t.accent) : t.border)
    .opacity(disabled ? 0.5 : 1).hover(s => disabled ? s : s.opacity(0.85))
    .on_mouse_down('left', (e,cx) => { cx.stop_propagation(); if (!disabled) action(cx,e); }).child(label);
}
const title = (t,text) => div().text_size(18).font_semibold().text_color(t.foreground).child(text);
export const securityMethods = {
  openConnectionDialog(mode = 'menu', event) {
    openOverlay({ mod: 'ide-review', kind: 'popup', width: 300,
      at: popoverAnchor(event, 300),
      props: { securityDialog: mode, paired: Boolean(this.extStatus?.installed) } });
  },
  async beginPair(cx) {
    if (this.pairBusy || this.revokeBusy) return;
    this.pairBusy = true; this.pairError = ''; this.pairCopied = false;
    this.pairSuccess = false; this.revokeConfirm = false;
    cx.notify();
    try {
      const status = await this.bridgeCommand('--check-ext');
      this.extStatus = status;
      this.pairBaseline = status.pairedAt;
      this.pairCode = await this.bridgeCommand('--pair');
    } catch { this.pairError = '无法生成配对码，请检查服务连接。'; }
    finally { this.pairBusy = false; cx.notify(); }
  },
  async pollPair(cx) {
    if (this.pairBusy || this.pairPollBusy || this.pairSuccess || !this.pairCode) return;
    this.pairPollBusy = true;
    try {
      const status = await this.bridgeCommand('--check-ext');
      this.extStatus = status;
      if (status.installed && status.pairedAt !== this.pairBaseline) {
        this.pairSuccess = true; this.pairCode = null;
        cx.timer.after(1400, () => closeOverlay(props().overlay));
      }
    } catch { this.pairError = '服务暂时无法连接。'; }
    finally { this.pairPollBusy = false; cx.notify(); }
  },
  closeSecurityDialog() {
    if (!this.revokeBusy) closeOverlay(props().overlay);
  },
  async revokeConnection(cx) {
    if (this.revokeBusy || this.pairBusy) return;
    this.revokeBusy = true; this.pairError = ''; cx.notify();
    try {
      await this.bridgeCommand('--revoke');
      this.extStatus = { installed: false, connected: false };
      this.pairCode = null; this.pairSuccess = false; this.revokeConfirm = false;
      notify({ title: '浏览器配对已撤销', body: '已有标注保留，旧凭据已失效。' });
    } catch { this.pairError = '撤销失败，请检查服务后重试。'; }
    finally { this.revokeBusy = false; cx.notify(); }
  },
  renderConnectionPill(t) {
    const label = connectionLabel(this.bridgeOnline, this.extStatus);
    return h_flex().id('review-connection-pill').h(24).px(8).gap(6).flex_none().rounded(12)
      .bg(t.surface).border(1).border_color(t.border).items_center().text_size(11).text_color(t.muted)
      .hover(s => s.bg(t.hover)).tooltip('浏览器连接设置')
      .on_mouse_down('left', (e,cx) => { cx.stop_propagation(); this.openConnectionDialog('menu',e); })
      .child(div().size(6).rounded(3).bg(this.extStatus?.connected && this.bridgeOnline ? t.done : t.dim))
      .child(label);
  },
  renderSecurityDialog(cx) {
    const t = theme();
    const paired = Boolean(this.extStatus?.installed);
    const expired = Boolean(this.pairCode && this.pairCode.expiresAt <= Date.now());
    const busy = this.pairBusy || this.revokeBusy;
    const item = (id,label,action,{danger = false,disabled = false,suffix = ''} = {}) =>
      h_flex().id(id).h(34).px(10).gap(8).flex_none().rounded(6).items_center()
        .text_size(12).text_color(danger ? t.blocked : t.foreground).opacity(disabled ? 0.5 : 1)
        .hover(s => disabled ? s : s.bg(t.hover))
        .on_mouse_down('left', (_e,cx) => { cx.stop_propagation(); if (!disabled) action(cx); })
        .child(div().flex_1().min_w(0).truncate().child(label))
        .when(Boolean(suffix),el => el.child(div().flex_none().text_size(11).text_color(t.dim).child(suffix)));
    return v_flex().id('connection-settings-menu').w_full().p(5).gap(2).bg(t.popover)
      .track_focus(this.handle)
      .on_key_down((e,cx) => { if (e.key?.toLowerCase() === 'escape') { cx.stop_propagation(); this.closeSecurityDialog(); } })
      .child(item('connection-menu-pair',this.pairBusy ? '正在生成配对码…' : paired ? '重新配对' : '配对浏览器',cx => this.beginPair(cx),{disabled:busy,suffix:this.pairCode ? '↻' : ''}))
      .when(Boolean(this.pairCode),el => el.child(v_flex().mx(5).mb(4).p(10).gap(5).rounded(6).bg(t.surface)
        .child(h_flex().justify_between().items_center().text_size(10.5).text_color(t.dim)
          .child('在 Chrome 插件设置中输入')
          .child(remainingTime(this.pairCode.expiresAt)))
        .child(div().id('connection-pair-code').h(32).w_full().rounded(5).flex().items_center().justify_center()
          .font_family('JetBrains Mono').text_size(16).font_semibold().text_color(expired ? t.dim : t.foreground)
          .hover(s => s.bg(t.hover)).tooltip(expired ? '配对码已过期，点击重新生成' : '点击复制配对码')
          .on_mouse_down('left', (_e,cx) => {
            cx.stop_propagation(); if (busy) return;
            if (expired) { this.beginPair(cx); return; }
            cx.write_to_clipboard(this.pairCode.code); this.pairCopied = true; cx.notify();
          }).child(formatCode(this.pairCode.code)))
        .when(this.pairCopied && !expired,el => el.child(div().text_size(10.5).text_color(t.done).child('已复制 ✓')))))
      .when(this.pairSuccess,el => el.child(div().px(10).py(6).text_size(12).text_color(t.done).child('已配对 ✓')))
      .child(item('connection-menu-install',this.installingExt ? '正在安装 / 更新…' : '安装 / 更新插件',cx => this.installChromeExt(cx),{disabled:this.installingExt || busy}))
      .child(item('connection-menu-folder','复制插件目录',cx => {
        const extensionDir = bundledExtensionDir();
        cx.write_to_clipboard(extensionDir);
        notify({ title: '已复制插件目录', body: extensionDir, timeout: 2500 });
      }))
      .when(paired,el => el.child(div().mx(5).my(3).h(1).bg(t.border))
        .child(item('connection-menu-revoke','撤销配对',cx => { this.revokeConfirm = true; cx.notify(); },{danger:true,disabled:busy})))
      .when(this.revokeConfirm,el => el.child(v_flex().mx(5).p(10).gap(8).rounded(6).bg(t.surface)
        .child(div().text_size(11).text_color(t.muted).child('撤销后需重新配对，已有标注保留。'))
        .child(h_flex().justify_end().gap(6)
          .child(button(t,'connection-revoke-cancel','取消',cx => { this.revokeConfirm = false; cx.notify(); },false,false,this.revokeBusy))
          .child(button(t,'connection-revoke-confirm',this.revokeBusy ? '正在撤销…' : '确认撤销',cx => this.revokeConnection(cx),true,true,this.revokeBusy)))))
      .when(Boolean(this.installFix?.url), el => el.child(item('connection-menu-permission','打开系统权限设置',() => {
        exec('open', [this.installFix.url]).catch(() => {});
      })))
      .when(Boolean(this.pairError),el => el.child(div().px(10).py(6).text_size(11).text_color(t.blocked).child(this.pairError)));
  },
  renderConnectionEmpty(t) {
    const paired = this.extStatus?.installed;
    return v_flex().flex_1().min_h(0).p(28).items_center().justify_center().gap(18)
      .child(div().size(52).rounded(14).bg(t.selected).flex().items_center().justify_center()
        .child(svg('mods/ide-review/review.svg').size(25).text_color(t.accent)))
      .child(title(t,paired ? '开始一次页面走查' : '把页面反馈带回 Herdr'))
      .child(div().max_w(350).text_center().text_size(12).text_color(t.muted)
        .child(paired ? '在 Chrome 点击插件图标，选择页面元素并添加意见。标注和截图会出现在这里。' : '连接 Chrome 插件，直接标注页面元素、区域和源码位置。'))
      .child(h_flex().gap(8)
        .when(!paired,el => el.child(button(t,'empty-connect','连接浏览器',(_cx,e) => this.openConnectionDialog('menu',e),true)))
        .child(button(t,'empty-install',this.installingExt ? '正在安装 / 更新…' : '安装 / 更新插件',cx => this.installChromeExt(cx),false,false,this.installingExt)))
      .child(div().max_w(350).text_center().text_size(11).text_color(t.dim).child('标注仅暂存 · 发送前预览确认 · 不会自动执行 Agent'));
  },
};
