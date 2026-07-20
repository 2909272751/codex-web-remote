using QRCoder;
using System.Diagnostics;
using System.Drawing.Drawing2D;

namespace CodexWebRemote;

internal sealed class MainForm : Form
{
    private readonly AppPaths _paths;
    private readonly ConfigStore _config;
    private readonly ServerManager _server;
    private readonly UpdateService _updates;
    private readonly bool _background;
    private readonly NotifyIcon _tray;
    private readonly System.Windows.Forms.Timer _updateTimer = new() { Interval = 3000 };
    private readonly Panel _content = new() { Dock = DockStyle.Fill, AutoScroll = true };
    private Label? _statusTitle;
    private Label? _statusDetail;
    private Button? _startStop;
    private Label? _updateStatus;
    private Button? _updateButton;
    private ReleaseInfo? _latestRelease;
    private DateTime _lastUpdateCheck = DateTime.MinValue;
    private bool _checkingUpdate;
    private bool _applyingUpdate;
    private bool _allowExit;
    private bool _loaded;

    private static readonly Color Ink = Color.FromArgb(28, 28, 34);
    private static readonly Color Muted = Color.FromArgb(112, 112, 124);
    private static readonly Color Purple = Color.FromArgb(117, 73, 244);
    private static readonly Color Pale = Color.FromArgb(247, 245, 253);
    private static readonly Font UiFont = new("Microsoft YaHei UI", 10F);

    public MainForm(AppPaths paths, ConfigStore config, ServerManager server, bool background)
    {
        _paths = paths; _config = config; _server = server; _updates = new UpdateService(paths); _background = background;
        Text = "Codex Web Remote";
        Font = UiFont;
        BackColor = Color.FromArgb(250, 250, 252);
        ForeColor = Ink;
        ClientSize = new Size(840, 650);
        MinimumSize = new Size(700, 560);
        StartPosition = FormStartPosition.CenterScreen;
        AutoScaleMode = AutoScaleMode.Dpi;
        if (_background && _config.Load() is not null) { Opacity = 0; ShowInTaskbar = false; WindowState = FormWindowState.Minimized; }
        Controls.Add(_content);

        var menu = new ContextMenuStrip { Font = UiFont };
        menu.Items.Add("打开控制中心", null, (_, _) => SafeShow());
        menu.Items.Add("打开 Web 页面", null, (_, _) => OpenWeb());
        menu.Items.Add("重启服务", null, async (_, _) => await _server.RestartAsync());
        menu.Items.Add("检查软件更新", null, async (_, _) => { SafeShow(); await CheckForUpdatesAsync(true); });
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add("退出", null, async (_, _) => await ExitAsync());
        _tray = new NotifyIcon
        {
            Icon = SystemIcons.Application,
            Text = "Codex Web Remote",
            Visible = true,
            ContextMenuStrip = menu,
        };
        _tray.DoubleClick += (_, _) => SafeShow();
        _server.Changed += ServerChanged;
        _updateTimer.Tick += async (_, _) => await UpdateTimerTickAsync();
        Shown += OnFirstShown;
        FormClosing += OnFormClosing;
    }

    private async void OnFirstShown(object? sender, EventArgs e)
    {
        if (_loaded) return;
        _loaded = true;
        if (_config.Load() is null)
        {
            BuildSetupView();
            return;
        }

        BuildDashboard();
        if (_background)
        {
            Hide();
            ShowInTaskbar = false;
            Opacity = 1;
        }
        await _server.StartAsync();
        _updateTimer.Start();
        await CheckForUpdatesAsync(false);
    }

    private void BuildSetupView()
    {
        _content.Controls.Clear();
        var page = PagePanel();
        page.Controls.Add(Title("欢迎使用 Codex Web Remote", 24));
        page.Controls.Add(Body("只需完成一次设置。之后服务会在登录 Windows 后自动启动，手机和 iPad 直接打开网址即可。"));

        var checks = new TableLayoutPanel { AutoSize = true, Width = 735, ColumnCount = 3, Dock = DockStyle.Top, Padding = new Padding(0, 12, 0, 12) };
        checks.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 33.33F));
        checks.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 33.33F));
        checks.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 33.34F));
        checks.Controls.Add(CheckCard("Codex App", DetectCodex() ? "已检测到" : "未检测到，请先安装登录", DetectCodex()), 0, 0);
        checks.Controls.Add(CheckCard("Microsoft Edge", DetectEdge() ? "已安装" : "未检测到", DetectEdge()), 1, 0);
        checks.Controls.Add(CheckCard("运行组件", File.Exists(_paths.NodePath) ? "完整" : "需要重新安装", File.Exists(_paths.NodePath)), 2, 0);
        page.Controls.Add(checks);

        var password = Input("访问密码（至少 8 位）", true);
        var confirm = Input("再次输入密码", true);
        var port = NumberInput("本机端口", 18888);
        var publicUrl = Input("88frp 公网地址（可稍后填写）", false);
        var fields = new TableLayoutPanel { Width = 735, Height = 148, ColumnCount = 2, RowCount = 2, Margin = new Padding(0, 5, 0, 0) };
        fields.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 50));
        fields.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 50));
        fields.RowStyles.Add(new RowStyle(SizeType.Absolute, 72));
        fields.RowStyles.Add(new RowStyle(SizeType.Absolute, 72));
        foreach (var field in new[] { password.Panel, confirm.Panel, port.Panel, publicUrl.Panel }) { field.Width = 355; field.Margin = new Padding(0, 3, 10, 0); }
        fields.Controls.Add(password.Panel, 0, 0);
        fields.Controls.Add(confirm.Panel, 1, 0);
        fields.Controls.Add(port.Panel, 0, 1);
        fields.Controls.Add(publicUrl.Panel, 1, 1);
        var autoStart = new CheckBox { Text = "登录 Windows 后自动启动（推荐）", Checked = true, AutoSize = true, Margin = new Padding(0, 12, 0, 5) };
        page.Controls.Add(fields);
        page.Controls.Add(autoStart);

        var start = PrimaryButton("完成设置并启动");
        start.Click += async (_, _) =>
        {
            if (password.Box.Text.Length < 8) { MessageBox.Show("密码至少需要 8 位。", Text, MessageBoxButtons.OK, MessageBoxIcon.Warning); return; }
            if (password.Box.Text != confirm.Box.Text) { MessageBox.Show("两次输入的密码不一致。", Text, MessageBoxButtons.OK, MessageBoxIcon.Warning); return; }
            start.Enabled = false;
            if (!ValidOptionalUrl(publicUrl.Box.Text)) { MessageBox.Show("公网地址必须以 http:// 或 https:// 开头。", Text); start.Enabled = true; return; }
            _config.Save(password.Box.Text, (int)port.Box.Value, false, autoStart.Checked, publicUrl.Box.Text);
            await _server.StartAsync();
            BuildDashboard();
            _updateTimer.Start();
            await CheckForUpdatesAsync(false);
        };
        page.Controls.Add(start);
        _content.Controls.Add(page);
    }

    private void BuildDashboard()
    {
        _content.Controls.Clear();
        var settings = _config.Load()!;
        var page = PagePanel();
        var top = new TableLayoutPanel { AutoSize = true, Width = 735, Dock = DockStyle.Top, ColumnCount = 2, Margin = new Padding(0) };
        top.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 70));
        top.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 30));
        var titleBox = new FlowLayoutPanel { AutoSize = true, FlowDirection = FlowDirection.TopDown, WrapContents = false, Dock = DockStyle.Fill };
        titleBox.Controls.Add(Title("Codex Web Remote", 23));
        titleBox.Controls.Add(Body("远程访问控制中心"));
        top.Controls.Add(titleBox, 0, 0);
        var open = PrimaryButton("打开 Web 页面");
        open.Anchor = AnchorStyles.Right | AnchorStyles.Top;
        open.Click += (_, _) => OpenWeb();
        top.Controls.Add(open, 1, 0);
        page.Controls.Add(top);

        var statusCard = Card();
        _statusTitle = new Label { AutoSize = true, Font = new Font(UiFont.FontFamily, 15, FontStyle.Bold), ForeColor = Ink };
        _statusDetail = new Label { AutoSize = true, ForeColor = Muted, Margin = new Padding(0, 7, 0, 12) };
        var actions = new FlowLayoutPanel { AutoSize = true, FlowDirection = FlowDirection.LeftToRight };
        _startStop = SecondaryButton("启动服务");
        _startStop.Click += async (_, _) => { if (_server.State == GatewayState.Running) await _server.StopAsync(); else await _server.StartAsync(); };
        var restart = SecondaryButton("重启"); restart.Click += async (_, _) => await _server.RestartAsync();
        var log = SecondaryButton("打开日志"); log.Click += (_, _) => OpenPath(_paths.LogFile);
        actions.Controls.AddRange([_startStop, restart, log]);
        statusCard.Controls.Add(_statusTitle); statusCard.Controls.Add(_statusDetail); statusCard.Controls.Add(actions);
        page.Controls.Add(statusCard);

        var updateCard = Card();
        updateCard.Controls.Add(SectionTitle("软件更新"));
        _updateStatus = Body(_latestRelease is not null && _updates.IsNewer(_latestRelease)
            ? $"发现新版本 {_latestRelease.TagName}，可一键安全更新。"
            : $"当前版本 v{_updates.CurrentVersion.ToString(3)}");
        _updateButton = SecondaryButton(_latestRelease is not null && _updates.IsNewer(_latestRelease) ? "立即更新" : "检查更新");
        _updateButton.Click += async (_, _) =>
        {
            if (_latestRelease is not null && _updates.IsNewer(_latestRelease)) await ApplyUpdateAsync(_latestRelease, false);
            else await CheckForUpdatesAsync(true);
        };
        updateCard.Controls.Add(_updateStatus);
        updateCard.Controls.Add(_updateButton);
        page.Controls.Add(updateCard);

        var connection = Card();
        connection.Controls.Add(SectionTitle("连接设备"));
        var connectionGrid = new TableLayoutPanel { AutoSize = true, Width = 690, ColumnCount = 2, Dock = DockStyle.Top };
        connectionGrid.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 65));
        connectionGrid.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 35));
        var info = new FlowLayoutPanel { AutoSize = true, FlowDirection = FlowDirection.TopDown, WrapContents = false, Dock = DockStyle.Fill };
        info.Controls.Add(Body($"本机地址：{settings.Url}"));
        info.Controls.Add(Body($"88frp：本地地址 127.0.0.1，本地端口 {settings.Port}"));
        info.Controls.Add(Body(string.IsNullOrWhiteSpace(settings.PublicUrl) ? "填写公网地址后，右侧二维码可直接供手机扫描。" : $"公网地址：{settings.PublicUrl}"));
        var copy = SecondaryButton("复制 88frp 配置");
        copy.Click += (_, _) => { Clipboard.SetText($"本地地址：127.0.0.1{Environment.NewLine}本地端口：{settings.Port}"); Toast("配置已复制"); };
        info.Controls.Add(copy);
        connectionGrid.Controls.Add(info, 0, 0);
        var qr = new PictureBox { Width = 150, Height = 150, SizeMode = PictureBoxSizeMode.Zoom, Image = CreateQr(settings.QrUrl), Anchor = AnchorStyles.Top | AnchorStyles.Right };
        connectionGrid.Controls.Add(qr, 1, 0);
        connection.Controls.Add(connectionGrid);
        page.Controls.Add(connection);

        var preferences = Card();
        preferences.Controls.Add(SectionTitle("设置"));
        var password = Input("新密码（留空表示不修改）", true);
        var confirm = Input("确认新密码", true);
        var port = NumberInput("本机端口", settings.Port);
        var publicUrl = Input("88frp 公网地址", false);
        publicUrl.Box.Text = settings.PublicUrl;
        var secure = new CheckBox { Text = "公网入口使用 HTTPS（启用 Secure Cookie）", Checked = settings.SecureCookie, AutoSize = true, Margin = new Padding(0, 9, 0, 5) };
        var autoStart = new CheckBox { Text = "登录 Windows 后自动启动", Checked = settings.AutoStart, AutoSize = true, Margin = new Padding(0, 5, 0, 12) };
        preferences.Controls.Add(password.Panel); preferences.Controls.Add(confirm.Panel); preferences.Controls.Add(port.Panel); preferences.Controls.Add(publicUrl.Panel); preferences.Controls.Add(secure); preferences.Controls.Add(autoStart);
        var save = PrimaryButton("保存并重启");
        save.Click += async (_, _) =>
        {
            var newPassword = password.Box.Text;
            if (newPassword.Length > 0 && newPassword.Length < 8) { MessageBox.Show("新密码至少需要 8 位。", Text); return; }
            if (newPassword != confirm.Box.Text) { MessageBox.Show("两次输入的新密码不一致。", Text); return; }
            if (!ValidOptionalUrl(publicUrl.Box.Text)) { MessageBox.Show("公网地址必须以 http:// 或 https:// 开头。", Text); return; }
            if (string.IsNullOrEmpty(newPassword)) newPassword = _config.UnprotectPassword(settings);
            _config.Save(newPassword, (int)port.Box.Value, secure.Checked, autoStart.Checked, publicUrl.Box.Text);
            await _server.RestartAsync();
            BuildDashboard();
        };
        preferences.Controls.Add(save);
        page.Controls.Add(preferences);
        _content.Controls.Add(page);
        RefreshStatus();
    }

    private void ServerChanged()
    {
        if (IsDisposed) return;
        BeginInvoke(RefreshStatus);
    }

    private void RefreshStatus()
    {
        if (_statusTitle is null || _statusDetail is null || _startStop is null) return;
        var running = _server.State == GatewayState.Running;
        _statusTitle.Text = _server.State switch
        {
            GatewayState.Running => "● 服务运行中",
            GatewayState.Starting => "◌ 正在启动",
            GatewayState.Stopping => "◌ 正在停止",
            GatewayState.Failed => "● 服务异常",
            _ => "○ 服务已停止",
        };
        _statusTitle.ForeColor = running ? Color.FromArgb(28, 150, 96) : _server.State == GatewayState.Failed ? Color.FromArgb(201, 63, 78) : Ink;
        _statusDetail.Text = _server.Detail;
        _startStop.Text = running ? "停止服务" : "启动服务";
        _tray.Text = running ? "Codex Web Remote - 运行中" : "Codex Web Remote - 已停止";
    }

    private async Task CheckForUpdatesAsync(bool manual)
    {
        if (_checkingUpdate || _applyingUpdate) return;
        _checkingUpdate = true;
        if (_updateStatus is not null) _updateStatus.Text = "正在通过 GitHub 检查新版本…";
        if (_updateButton is not null) _updateButton.Enabled = false;
        try
        {
            _latestRelease = await _updates.CheckAsync();
            _lastUpdateCheck = DateTime.UtcNow;
            var available = _latestRelease is not null && _updates.IsNewer(_latestRelease);
            if (_updateStatus is not null) _updateStatus.Text = available
                ? $"发现新版本 {_latestRelease!.TagName}，更新时服务会短暂重启。"
                : $"当前已是最新版 v{_updates.CurrentVersion.ToString(3)}";
            if (_updateButton is not null) _updateButton.Text = available ? "立即更新" : "重新检查";
            if (available)
            {
                Toast($"发现 Codex Web Remote {_latestRelease!.TagName}", 5000);
                _tray.ShowBalloonTip(5000, "发现新版本", $"{_latestRelease.TagName} 已发布，可在控制中心一键更新。", ToolTipIcon.Info);
            }
            else if (manual) Toast("当前已是最新版");
        }
        catch (Exception ex)
        {
            if (_updateStatus is not null) _updateStatus.Text = $"检查失败：{ex.Message}";
            if (manual) MessageBox.Show($"无法检查 GitHub 更新：{ex.Message}", Text, MessageBoxButtons.OK, MessageBoxIcon.Warning);
        }
        finally
        {
            _checkingUpdate = false;
            if (_updateButton is not null) _updateButton.Enabled = true;
        }
    }

    private async Task UpdateTimerTickAsync()
    {
        if (_applyingUpdate || _checkingUpdate) return;
        if (File.Exists(_paths.UpdateRequestFile))
        {
            try { File.Delete(_paths.UpdateRequestFile); } catch { return; }
            await CheckForUpdatesAsync(false);
            if (_latestRelease is not null && _updates.IsNewer(_latestRelease)) await ApplyUpdateAsync(_latestRelease, true);
            return;
        }
        if (DateTime.UtcNow - _lastUpdateCheck > TimeSpan.FromHours(6)) await CheckForUpdatesAsync(false);
    }

    private async Task ApplyUpdateAsync(ReleaseInfo release, bool remoteRequested)
    {
        if (_applyingUpdate) return;
        if (!remoteRequested && MessageBox.Show($"将更新到 {release.TagName}。服务会短暂断开并自动重启，是否继续？", Text, MessageBoxButtons.YesNo, MessageBoxIcon.Question) != DialogResult.Yes) return;
        _applyingUpdate = true;
        if (_updateButton is not null) _updateButton.Enabled = false;
        try
        {
            var progress = new Progress<int>(value =>
            {
                if (_updateStatus is not null) _updateStatus.Text = $"正在下载并校验 {release.TagName}… {value}%";
            });
            var prepared = await _updates.DownloadAsync(release, progress);
            if (_updateStatus is not null) _updateStatus.Text = "更新包校验通过，正在重启安装…";
            var helper = new ProcessStartInfo(prepared.HelperPath) { UseShellExecute = true };
            helper.ArgumentList.Add("--apply-update");
            helper.ArgumentList.Add(prepared.SetupPath);
            helper.ArgumentList.Add(_paths.AppRoot);
            helper.ArgumentList.Add(Environment.ProcessId.ToString());
            Process.Start(helper);
            _allowExit = true;
            _updateTimer.Stop();
            await _server.StopAsync();
            _tray.Visible = false;
            Application.Exit();
        }
        catch (Exception ex)
        {
            _applyingUpdate = false;
            if (_updateButton is not null) _updateButton.Enabled = true;
            if (_updateStatus is not null) _updateStatus.Text = $"更新失败：{ex.Message}";
            MessageBox.Show(ex.Message, "更新失败", MessageBoxButtons.OK, MessageBoxIcon.Error);
        }
    }

    public void SafeShow()
    {
        if (IsDisposed) return;
        BeginInvoke(() => { Opacity = 1; ShowInTaskbar = true; Show(); WindowState = FormWindowState.Normal; Activate(); BuildDashboardIfReady(); });
    }

    public void SafeExit()
    {
        if (IsDisposed) return;
        BeginInvoke(async () => await ExitAsync());
    }

    private async Task ExitAsync()
    {
        _allowExit = true;
        await _server.StopAsync();
        _tray.Visible = false;
        Application.Exit();
    }

    private void BuildDashboardIfReady() { if (_config.Load() is not null) BuildDashboard(); else BuildSetupView(); }

    private void OnFormClosing(object? sender, FormClosingEventArgs e)
    {
        if (_allowExit || e.CloseReason == CloseReason.WindowsShutDown) return;
        e.Cancel = true;
        Hide();
        ShowInTaskbar = false;
        Toast("程序仍在后台运行，可从托盘图标打开。", 2500);
    }

    private void OpenWeb()
    {
        var settings = _config.Load();
        if (settings is null) { SafeShow(); return; }
        Process.Start(new ProcessStartInfo(settings.Url) { UseShellExecute = true });
    }

    private static void OpenPath(string path)
    {
        if (!File.Exists(path)) File.WriteAllText(path, "");
        Process.Start(new ProcessStartInfo(path) { UseShellExecute = true });
    }

    private void Toast(string message, int timeout = 1800) => _tray.ShowBalloonTip(timeout, "Codex Web Remote", message, ToolTipIcon.Info);

    private static bool DetectCodex()
    {
        var packages = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Packages");
        return Directory.Exists(packages) && Directory.EnumerateDirectories(packages, "OpenAI.Codex*").Any();
    }

    private static bool DetectEdge() => new[]
    {
        Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86), "Microsoft", "Edge", "Application", "msedge.exe"),
        Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "Microsoft", "Edge", "Application", "msedge.exe"),
    }.Any(File.Exists);

    private static bool ValidOptionalUrl(string value) => string.IsNullOrWhiteSpace(value) || (Uri.TryCreate(value.Trim(), UriKind.Absolute, out var uri) && (uri.Scheme == Uri.UriSchemeHttp || uri.Scheme == Uri.UriSchemeHttps));

    private static Image? CreateQr(string text)
    {
        try
        {
            using var generator = new QRCodeGenerator();
            using var data = generator.CreateQrCode(text, QRCodeGenerator.ECCLevel.Q);
            var png = new PngByteQRCode(data).GetGraphic(8, new byte[] { 45, 35, 72 }, new byte[] { 255, 255, 255 });
            using var stream = new MemoryStream(png);
            using var loaded = new Bitmap(stream);
            return new Bitmap(loaded);
        }
        catch { return null; }
    }

    private static FlowLayoutPanel PagePanel() => new()
    {
        Dock = DockStyle.Top,
        AutoSize = true,
        FlowDirection = FlowDirection.TopDown,
        WrapContents = false,
        Padding = new Padding(36, 30, 36, 40),
        Width = 810,
    };

    private static FlowLayoutPanel Card()
    {
        var panel = new RoundedPanel { Width = 735, MinimumSize = new Size(735, 0), AutoSize = true, FlowDirection = FlowDirection.TopDown, WrapContents = false, Padding = new Padding(22), Margin = new Padding(0, 12, 0, 0), BackColor = Color.White };
        return panel;
    }

    private static Control CheckCard(string title, string detail, bool good)
    {
        var panel = new RoundedPanel { Width = 232, Height = 88, Padding = new Padding(15), Margin = new Padding(0, 0, 10, 0), BackColor = good ? Color.FromArgb(241, 251, 246) : Color.FromArgb(255, 247, 237), FlowDirection = FlowDirection.TopDown, WrapContents = false };
        panel.Controls.Add(new Label { Text = title, Width = 195, Height = 27, Font = new Font(UiFont.FontFamily, 11, FontStyle.Bold), ForeColor = Ink });
        panel.Controls.Add(new Label { Text = detail, Width = 195, Height = 27, ForeColor = good ? Color.FromArgb(35, 135, 91) : Color.FromArgb(174, 105, 30), AutoEllipsis = true });
        return panel;
    }

    private static Label Title(string text, float size) => new() { Text = text, AutoSize = true, Font = new Font(UiFont.FontFamily, size, FontStyle.Bold), ForeColor = Ink, Margin = new Padding(0, 0, 0, 5) };
    private static Label SectionTitle(string text) => new() { Text = text, AutoSize = true, Font = new Font(UiFont.FontFamily, 13, FontStyle.Bold), ForeColor = Ink, Margin = new Padding(0, 0, 0, 10) };
    private static Label Body(string text) => new() { Text = text, AutoSize = true, MaximumSize = new Size(690, 0), ForeColor = Muted, Margin = new Padding(0, 0, 0, 5) };

    private static (Panel Panel, TextBox Box) Input(string label, bool password)
    {
        var panel = new Panel { Width = 700, Height = 72, Margin = new Padding(0, 7, 0, 0) };
        var caption = new Label { Text = label, Dock = DockStyle.Top, Height = 25, ForeColor = Ink };
        var box = new TextBox { Dock = DockStyle.Bottom, Height = 36, UseSystemPasswordChar = password, BorderStyle = BorderStyle.FixedSingle, Font = new Font(UiFont.FontFamily, 11) };
        panel.Controls.Add(box); panel.Controls.Add(caption);
        return (panel, box);
    }

    private static (Panel Panel, NumericUpDown Box) NumberInput(string label, int value)
    {
        var panel = new Panel { Width = 700, Height = 72, Margin = new Padding(0, 7, 0, 0) };
        var caption = new Label { Text = label, Dock = DockStyle.Top, Height = 25, ForeColor = Ink };
        var box = new NumericUpDown { Dock = DockStyle.Bottom, Height = 36, Minimum = 1024, Maximum = 65535, Value = Math.Clamp(value, 1024, 65535), BorderStyle = BorderStyle.FixedSingle, Font = new Font(UiFont.FontFamily, 11) };
        panel.Controls.Add(box); panel.Controls.Add(caption);
        return (panel, box);
    }

    private static Button PrimaryButton(string text) => new() { Text = text, AutoSize = true, MinimumSize = new Size(136, 42), FlatStyle = FlatStyle.Flat, BackColor = Purple, ForeColor = Color.White, Cursor = Cursors.Hand, Margin = new Padding(0, 12, 8, 0), Padding = new Padding(12, 4, 12, 4) };
    private static Button SecondaryButton(string text) => new() { Text = text, AutoSize = true, MinimumSize = new Size(100, 38), FlatStyle = FlatStyle.Flat, BackColor = Pale, ForeColor = Ink, Cursor = Cursors.Hand, Margin = new Padding(0, 4, 8, 0), Padding = new Padding(10, 3, 10, 3) };

    protected override void Dispose(bool disposing)
    {
        if (disposing) { _server.Changed -= ServerChanged; _updateTimer.Dispose(); _updates.Dispose(); _tray.Dispose(); UiFont.Dispose(); }
        base.Dispose(disposing);
    }
}

internal sealed class RoundedPanel : FlowLayoutPanel
{
    public int Radius { get; set; } = 18;
    protected override void OnPaint(PaintEventArgs e)
    {
        base.OnPaint(e);
        e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
        using var path = new GraphicsPath();
        var r = Radius * 2;
        path.AddArc(0, 0, r, r, 180, 90); path.AddArc(Width - r - 1, 0, r, r, 270, 90);
        path.AddArc(Width - r - 1, Height - r - 1, r, r, 0, 90); path.AddArc(0, Height - r - 1, r, r, 90, 90); path.CloseFigure();
        using var pen = new Pen(Color.FromArgb(228, 226, 235));
        e.Graphics.DrawPath(pen, path);
    }
}
