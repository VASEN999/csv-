// 全局变量
let currentCsvData = null;
let currentPassportData = null;
let currentRecordIndex = 0;
let currentPdfFilename = null;
let isProcessing = false;
let errorRecords = [];
let currentErrorIndex = -1;
let markedRecords = new Set();
let currentPdfScale = 1.0;
let currentPdfPage = null;
let acceptanceNumbersChecked = false; // 添加受理号核对标志
let markedAcceptanceNumbers = new Set(); // 添加标记的受理号集合
let highlightedAcceptanceNumbers = []; // 存储需要重点核对的受理号索引
let shouldForcePdfReload = false; // 控制PDF是否需要强制刷新
let processedAcceptanceData = []; // 存储处理后的受理号数据，供表格渲染使用

// 拖拽相关变量
let isDragging = false;
let startX, startY, scrollLeft, scrollTop;

// 工具函数
function showLoading(element) {
    element.classList.add('loading');
}

function hideLoading(element) {
    element.classList.remove('loading');
}

function showError(message, details = null) {
    let errorMsg = '错误：' + message;
    if (details) {
        errorMsg += '\n\n详细信息：\n' + details;
    }
    alert(errorMsg);
}

function showSuccess(message) {
    alert('成功：' + message);
}

function showWarning(message) {
    alert('警告：' + message);
}

// 在showErrorMessage的位置或之前添加函数定义
function showErrorMessage(message) {
    showError(message);
}

/**
 * 分析团队受理号，检查前9位是否一致
 * @returns {Object} 团队受理号分析结果
 */
function analyzeTeamAcceptanceNumbers() {
    // 首先检查API返回的数据中是否包含团队受理号
    let hasTeamAcceptanceNumber = false;
    
    // 收集所有团队受理号
    const teamAcceptanceNumbers = [];
    const prefixCounts = {};
    
    // 检查API返回的数据
    if (currentCsvData && currentCsvData.length > 0) {
        currentCsvData.forEach((item, index) => {
            if (item.team_acceptance_number && item.team_acceptance_number.trim() !== '') {
                hasTeamAcceptanceNumber = true;
                const teamAcceptanceNumber = item.team_acceptance_number.trim();
                
                // 确保团队受理号长度至少为9位
                if (teamAcceptanceNumber.length >= 9) {
                    const prefix = teamAcceptanceNumber.substring(0, 9);
                    
                    teamAcceptanceNumbers.push({
                        index: index,
                        team_acceptance_number: teamAcceptanceNumber,
                        prefix: prefix,
                        acceptance_number: item.acceptance_number,
                        passport_number: item.passport_number
                    });
                    
                    // 统计前缀出现次数
                    prefixCounts[prefix] = (prefixCounts[prefix] || 0) + 1;
                } else {
                    // 团队受理号长度不足9位，视为异常
                    teamAcceptanceNumbers.push({
                        index: index,
                        team_acceptance_number: teamAcceptanceNumber,
                        prefix: teamAcceptanceNumber, // 使用整个团队受理号作为前缀
                        acceptance_number: item.acceptance_number,
                        passport_number: item.passport_number,
                        isInvalid: true
                    });
                    
                    // 统计前缀出现次数
                    prefixCounts[teamAcceptanceNumber] = (prefixCounts[teamAcceptanceNumber] || 0) + 1;
                }
            }
        });
    }
    
    // 如果没有团队受理号，返回空结果
    if (teamAcceptanceNumbers.length === 0) {
        console.log('未找到团队受理号数据');
        return {
            isConsistent: true,
            prefix: '',
            uniquePrefixes: [],
            prefixCounts: {},
            inconsistentItems: [],
            hasTeamAcceptanceNumber: hasTeamAcceptanceNumber
        };
    }
    
    console.log(`找到 ${teamAcceptanceNumbers.length} 个团队受理号`);
    
    // 获取所有不同的前缀
    const uniquePrefixes = Object.keys(prefixCounts);
    
    // 如果只有一种前缀，则一致
    const isConsistent = uniquePrefixes.length === 1;
    
    // 找出主要前缀（出现次数最多的）
    let mainPrefix = '';
    let maxCount = 0;
    
    for (const prefix in prefixCounts) {
        if (prefixCounts[prefix] > maxCount) {
            maxCount = prefixCounts[prefix];
            mainPrefix = prefix;
        }
    }
    
    // 找出不一致的记录
    const inconsistentItems = isConsistent ? [] : teamAcceptanceNumbers.filter(item => 
        item.prefix !== mainPrefix || item.isInvalid
    );
    
    return {
        isConsistent: isConsistent,
        prefix: mainPrefix,
        uniquePrefixes: uniquePrefixes,
        prefixCounts: prefixCounts,
        inconsistentItems: inconsistentItems,
        hasTeamAcceptanceNumber: hasTeamAcceptanceNumber
    };
}

/**
 * 格式化团队受理号中的日期部分
 * @param {string} dateStr 格式为YYMMDD的日期字符串
 * @returns {string} 格式化后的日期字符串
 */
function formatTeamAcceptanceDate(dateStr) {
    if (!dateStr || dateStr.length !== 6) {
        return dateStr;
    }
    
    const year = '20' + dateStr.substring(0, 2);
    const month = dateStr.substring(2, 4);
    const day = dateStr.substring(4, 6);
    
    return `${year}年${month}月${day}日`;
}

/**
 * 分析受理号序列，检测不连续点和潜在错误
 * @param {Array} items 受理号数据列表
 * @returns {Object} 带有分析结果的数据列表
 */
function analyzeAcceptanceNumbers(items) {
    // 复制数组，不修改原始数据
    const result = JSON.parse(JSON.stringify(items));
    const discontinuities = [];
    const emptyItems = [];
    let hasDiscontinuity = false;
    let hasEmptyAcceptanceNumbers = false;
    
    // 第一步：检测空受理号或格式异常的受理号
    for (let i = 0; i < result.length; i++) {
        const item = result[i];
        // 默认设置为未高亮
        item.isHighlighted = false;
        
        // 检查受理号是否为空或无效
        if (!item.acceptance_number || item.acceptance_number.trim() === '' || 
            item.acceptance_number === '(空)' || item.acceptance_number.toLowerCase() === 'nan') {
            // 标记为空受理号
            item.isHighlighted = true;
            item.position = 'empty';
            hasEmptyAcceptanceNumbers = true;
            emptyItems.push({
                index: i,
                position: i + 1, // 1-indexed 位置
                surname: item.surname || '',
                given_name: item.given_name || '',
                name: item.name || '',
                pinyin_name: item.pinyin_name || '',
                english_name: item.english_name || '',
                passport_number: item.passport_number || '未知',
                acceptance_number: item.acceptance_number || '',
                value: null // 明确标记为空值
            });
        }
    }
    
    // 第二步：提取数字受理号，排除非数字和空值
    const numericItems = [];
    for (let i = 0; i < result.length; i++) {
        const item = result[i];
        // 跳过已标记为空的受理号
        if (item.position === 'empty') continue;
        
        // 获取受理号的数字值（如果可能）
        const numValue = parseInt(item.acceptance_number);
        if (!isNaN(numValue)) {
            numericItems.push({
                index: i,
                value: numValue,
                item: item
            });
        } else {
            // 非数字但也不是空值，标记为格式异常
            item.isHighlighted = true;
            item.position = 'invalid_format';
            hasEmptyAcceptanceNumbers = true;
            emptyItems.push({
                index: i,
                position: i + 1, // 1-indexed 位置
                surname: item.surname || '',
                given_name: item.given_name || '',
                name: item.name || '',
                pinyin_name: item.pinyin_name || '',
                english_name: item.english_name || '',
                passport_number: item.passport_number || '未知',
                acceptance_number: item.acceptance_number,
                value: item.acceptance_number // 保留原始非数字值
            });
        }
    }
    
    // 如果数字受理号太少，无法分析
    if (numericItems.length < 2) {
        // 仅标记首尾（如果有）
        if (result.length > 0) {
            // 始终标记第一个受理号
            result[0].isHighlighted = true;
            result[0].position = 'first';
        }
        if (result.length > 1) {
            // 始终标记最后一个受理号
            result[result.length - 1].isHighlighted = true;
            result[result.length - 1].position = 'last';
        }
        return { 
            items: result, 
            hasDiscontinuity: false, 
            discontinuities: [],
            hasEmptyAcceptanceNumbers,
            emptyItems
        };
    }
    
    // 第三步：分析连续性和差距
    // 按照受理号的值排序（升序）
    numericItems.sort((a, b) => a.value - b.value);
    
    // 计算相邻数字间的差值，找出不连续点
    for (let i = 1; i < numericItems.length; i++) {
        const prev = numericItems[i - 1];
        const curr = numericItems[i];
        const expectedNext = prev.value + 1;
        
        // 如果当前值不是前一个值加1，则有不连续点
        if (curr.value !== expectedNext) {
            hasDiscontinuity = true;
            
            // 记录不连续点信息，确保所有必要的字段都存在
            const discontinuityInfo = {
                from: prev.value,
                to: curr.value,
                position: `${prev.index + 1}-${curr.index + 1}`, // 1-indexed 位置
                gap: curr.value - prev.value,
                // 添加原始索引，方便后续查找
                fromIndex: prev.index,
                toIndex: curr.index
            };
            
            console.log('发现不连续点:', discontinuityInfo); // 添加调试日志
            
            discontinuities.push(discontinuityInfo);
            
            // 标记不连续点前后的元素（如果它们还没有被标记）
            if (!result[prev.index].isHighlighted) {
                result[prev.index].isHighlighted = true;
                result[prev.index].position = 'discontinuity_before';
                console.log('标记不连续点之前元素:', prev.index, prev.value); // 添加调试日志
            }
            
            if (!result[curr.index].isHighlighted) {
                result[curr.index].isHighlighted = true;
                result[curr.index].position = 'discontinuity_after';
                console.log('标记不连续点之后元素:', curr.index, curr.value); // 添加调试日志
            }
        }
    }
    
    // 始终标记首尾受理号，无论它们是否已被标记
    if (result.length > 0) {
        result[0].isHighlighted = true;
        result[0].position = result[0].position || 'first';
    }
    
    if (result.length > 1) {
        const lastIndex = result.length - 1;
        result[lastIndex].isHighlighted = true;
        result[lastIndex].position = result[lastIndex].position || 'last';
    }
    
    return {
        items: result,
        hasDiscontinuity,
        discontinuities,
        hasEmptyAcceptanceNumbers,
        emptyItems
    };
}

/**
 * 更新团队受理号可视化卡片
 * @param {Object} teamAnalysisResult 团队受理号分析结果
 */
function updateTeamAcceptanceCodeVisualizer(teamAnalysisResult) {
    const teamAcceptanceStatus = document.getElementById('teamAcceptanceStatus');
    if (!teamAcceptanceStatus) {
        console.log('没有找到团队受理号状态元素');
        return;
    }
    
    const teamCodePrefix = document.getElementById('teamCodePrefix');
    const teamCodeDate = document.getElementById('teamCodeDate');
    const teamCodeSeq = document.getElementById('teamCodeSeq');
    const teamCodePrefixDesc = document.getElementById('teamCodePrefixDesc');
    const teamCodeDateDesc = document.getElementById('teamCodeDateDesc');
    const teamCodeSeqDesc = document.getElementById('teamCodeSeqDesc');
    
    if (teamAnalysisResult && teamAnalysisResult.hasTeamAcceptanceNumber) {
        // 显示可视化卡片
        const cardContainer = teamAcceptanceStatus.closest('.card');
        if (cardContainer) {
            cardContainer.style.display = 'block';
        }
        
        // 更新状态和视觉效果
        const visualizer = document.querySelector('.acceptance-code-visualizer');
        
        if (teamAnalysisResult.isConsistent) {
            teamAcceptanceStatus.className = 'badge bg-success';
            teamAcceptanceStatus.textContent = '统一';
            
            if (visualizer) visualizer.classList.remove('invalid');
        } else {
            const variantCount = teamAnalysisResult.uniquePrefixes ? teamAnalysisResult.uniquePrefixes.length : 0;
            teamAcceptanceStatus.className = 'badge bg-danger';
            teamAcceptanceStatus.textContent = `不一致(${variantCount}种)`;
            
            if (visualizer) visualizer.classList.add('invalid');
        }
        
        // 如果有有效的前缀
        if (teamAnalysisResult.prefix && teamAnalysisResult.prefix.length >= 9) {
            // 拆分前缀显示
            const prefix = teamAnalysisResult.prefix.substring(0, 3);
            const dateStr = teamAnalysisResult.prefix.substring(3, 9);
            const seqStr = teamAnalysisResult.prefix.length > 9 ? teamAnalysisResult.prefix.substring(9) : "1";
            
            if(teamCodePrefix) teamCodePrefix.textContent = prefix;
            if(teamCodeDate) teamCodeDate.textContent = dateStr;
            if(teamCodeSeq) teamCodeSeq.textContent = seqStr;
            
            // 更新描述
            if(teamCodePrefixDesc) teamCodePrefixDesc.textContent = `旅行社编码: ${prefix}`;
            
            // 格式化日期更具可读性
            const formattedDate = formatTeamAcceptanceDate(dateStr);
            if(teamCodeDateDesc) teamCodeDateDesc.textContent = `送签日期: ${formattedDate}`;
            if(teamCodeSeqDesc) teamCodeSeqDesc.textContent = `文件包序号: ${seqStr}`;
            
            // 如果不一致，展示异常信息
            if (!teamAnalysisResult.isConsistent && teamAnalysisResult.inconsistentItems) {
                const inconsistentCount = teamAnalysisResult.inconsistentItems.length;
                const totalCount = teamAnalysisResult.prefixCounts ? 
                    Object.values(teamAnalysisResult.prefixCounts).reduce((a, b) => a + b, 0) : 0;
                
                if (inconsistentCount > 0 && teamCodePrefixDesc) {
                    teamCodePrefixDesc.innerHTML += ` <span class="badge bg-danger">${inconsistentCount}/${totalCount}异常</span>`;
                }
            }
        } else {
            // 无效前缀，显示占位符
            if(teamCodePrefix) teamCodePrefix.textContent = "???";
            if(teamCodeDate) teamCodeDate.textContent = "??????";
            if(teamCodeSeq) teamCodeSeq.textContent = "?";
            
            if(teamCodePrefixDesc) teamCodePrefixDesc.textContent = "旅行社编码: 无效";
            if(teamCodeDateDesc) teamCodeDateDesc.textContent = "送签日期: 无效";
            if(teamCodeSeqDesc) teamCodeSeqDesc.textContent = "文件包序号: 无效";
        }
    } else {
        // 如果没有团队受理号，隐藏可视化卡片
        const cardContainer = teamAcceptanceStatus.closest('.card');
        if (cardContainer) {
            cardContainer.style.display = 'none';
        }
    }
}

// 清除缓存函数
async function clearCache() {
    if (!confirm('确定要清除所有数据吗？这将删除：\n\n' + 
                '- 已上传的CSV文件\n' +
                '- 已上传的证件照\n' +
                '- 已上传的护照PDF\n' +
                '- 所有缓存数据\n' +
                '- 所有处理结果\n\n' +
                '此操作无法撤销。')) {
        return;
    }
    
    try {
        const response = await fetch('/api/clear_cache', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            }
        });
        
        const result = await response.json();
        
        if (result.success) {
            // 重置所有全局变量
            currentCsvData = null;
            currentPassportData = null;
            currentRecordIndex = 0;
            currentPdfFilename = null;
            isProcessing = false;
            errorRecords = [];
            currentErrorIndex = -1;
            markedRecords = new Set();
            currentPdfScale = 1.0;
            currentPdfPage = null;
            acceptanceNumbersChecked = false;
            markedAcceptanceNumbers = new Set();
            highlightedAcceptanceNumbers = [];
            shouldForcePdfReload = false;
            
            // 重置界面显示
            clearDisplayData();
            clearCSVData();
            clearPassportData();
            clearCheckResults();
            
            // 重置按钮状态
            document.getElementById('preprocessButton').disabled = true;
            document.getElementById('prevRecord').disabled = true;
            document.getElementById('nextRecord').disabled = true;
            document.getElementById('recordCounter').textContent = '0/0';
            
            // 重置进度条
            const progressBar = document.getElementById('progressBar');
            const progressStatus = document.getElementById('progressStatus');
            if (progressBar) progressBar.style.display = 'none';
            if (progressStatus) progressStatus.textContent = '';
            
            // 清除文件输入框的值
            document.getElementById('csvFile').value = '';
            document.getElementById('photoFiles').value = '';
            document.getElementById('passportFile').value = '';
            
            // 显示成功消息
            showSuccess(result.message + '\n\n系统已重置到初始状态');
            
            // 重置签证类型统计
            resetVisaTypeStatistics();
            
        } else {
            showError('清除数据失败', result.error);
        }
    } catch (error) {
        showError('清除数据请求失败', error.message);
    }
}

// 确保DOM加载完成后再添加事件监听器
document.addEventListener('DOMContentLoaded', function() {
    // CSV 文件上传处理
    const csvFileInput = document.getElementById('csvFile');
    if (csvFileInput) {
        csvFileInput.addEventListener('change', handleCsvFileUpload);
    }

    // 护照文件上传处理
    const passportFileInput = document.getElementById('passportFile');
    if (passportFileInput) {
        passportFileInput.addEventListener('change', handlePassportFileUpload);
    }

    // 照片文件上传处理
    const photoFilesInput = document.getElementById('photoFiles');
    if (photoFilesInput) {
        photoFilesInput.addEventListener('change', handlePhotoFilesUpload);
    }

    // 其他按钮事件监听
    const prevRecordBtn = document.getElementById('prevRecord');
    const nextRecordBtn = document.getElementById('nextRecord');
    const preprocessBtn = document.getElementById('preprocessButton');
    const checkAllBtn = document.getElementById('checkAllButton');
    const recheckBtn = document.getElementById('recheckButton');
    
    // 添加清除缓存按钮事件
    const clearCacheBtn = document.getElementById('clearCacheButton');
    if (clearCacheBtn) {
        clearCacheBtn.addEventListener('click', clearCache);
    }

    if (prevRecordBtn) prevRecordBtn.addEventListener('click', showPreviousRecord);
    if (nextRecordBtn) nextRecordBtn.addEventListener('click', showNextRecord);
    if (preprocessBtn) preprocessBtn.addEventListener('click', startPreprocessing);
    if (checkAllBtn) checkAllBtn.addEventListener('click', checkAllRecords);
    if (recheckBtn) recheckBtn.addEventListener('click', recheckErrors);

    // 为"全部检查"按钮添加点击事件
    const checkAllButton = document.getElementById('checkAllButton');
    if (checkAllButton) {
        checkAllButton.addEventListener('click', checkAllRecords);
    }

    // 为"受理号核对"按钮添加单独的点击事件
    const reviewAcceptanceButton = document.getElementById('reviewAcceptanceButton');
    if (reviewAcceptanceButton) {
        reviewAcceptanceButton.addEventListener('click', function() {
            if (!currentCsvData) {
                showWarning('请先上传CSV文件');
                return;
            }
            
            showAcceptanceNumberModal();
        });
    }

    // 确认受理号按钮事件
    const confirmAcceptanceNumbersButton = document.getElementById('confirmAcceptanceNumbers');
    if (confirmAcceptanceNumbersButton) {
        confirmAcceptanceNumbersButton.addEventListener('click', function() {
            acceptanceNumbersChecked = true;
            const modal = bootstrap.Modal.getInstance(document.getElementById('acceptanceNumberModal'));
            modal.hide();
        });
    }
    
    // 受理号表格显示模式切换
    const showHighlightedRowsBtn = document.getElementById('showHighlightedRows');
    const showAllRowsBtn = document.getElementById('showAllRows');
    
    if (showHighlightedRowsBtn) {
        showHighlightedRowsBtn.addEventListener('click', function() {
            // 获取当前渲染函数
            const renderTable = window.currentRenderFunction;
            if (typeof renderTable === 'function') {
                renderTable('highlighted');
                
                // 更新按钮状态
                showHighlightedRowsBtn.classList.add('btn-primary');
                showHighlightedRowsBtn.classList.remove('btn-outline-primary');
                showAllRowsBtn.classList.remove('btn-primary');
                showAllRowsBtn.classList.add('btn-outline-primary');
            } else {
                console.error('渲染函数不可用');
            }
        });
    }
    
    if (showAllRowsBtn) {
        showAllRowsBtn.addEventListener('click', function() {
            // 获取当前渲染函数
            const renderTable = window.currentRenderFunction;
            if (typeof renderTable === 'function') {
                renderTable('all');
                
                // 更新按钮状态
                showAllRowsBtn.classList.add('btn-primary');
                showAllRowsBtn.classList.remove('btn-outline-primary');
                showHighlightedRowsBtn.classList.remove('btn-primary');
                showHighlightedRowsBtn.classList.add('btn-outline-primary');
            } else {
                console.error('渲染函数不可用');
            }
        });
    }
    
    // 绑定PDF视图区域拖拽和缩放事件
    bindZoomEvents();
    
    // 初始清除显示
    clearDisplayData();
    
    // 初始化受理号核对功能
    initAcceptanceNumberChecking();
});

// CSV文件上传处理函数
async function handleCsvFileUpload(e) {
    const file = e.target.files[0];
    if (!file) return;
    
    const formData = new FormData();
    formData.append('file', file);
    
    const passportInfo = document.querySelector('.passport-info');
    showLoading(passportInfo);
    
    try {
        // 重置所有与受理号核对相关的状态
        highlightedAcceptanceNumbers = [];  // 清空需重点核对的受理号
        markedAcceptanceNumbers.clear();    // 清空已标记的受理号
        acceptanceNumbersChecked = false;   // 重置核对标志
        
        // 清空相关的UI元素
        const analysisContent = document.getElementById('analysisContent');
        if (analysisContent) {
            analysisContent.innerHTML = '';
        }
        
        const tableBody = document.getElementById('acceptanceNumberTableBody');
        if (tableBody) {
            tableBody.innerHTML = '';
        }
        
        // 重置签证类型统计
        resetVisaTypeStatistics();
        
        // 重置统计显示
        const progressElement = document.getElementById('markProgress');
        if (progressElement) {
            progressElement.textContent = '已标记: 0/0';
        }
        
        const progressBar = document.getElementById('markProgressBar');
        if (progressBar) {
            progressBar.style.width = '0%';
            progressBar.className = 'progress-bar bg-warning';
        }
        
        const response = await fetch('/upload/csv', {
            method: 'POST',
            body: formData
        });
        
        const data = await response.json();
        if (data.error) {
            showError('上传CSV失败', data.error);
            return;
        }
        
        // 存储CSV数据
        currentCsvData = data.data;
        currentRecordIndex = 0;

        // 更详细的调试输出
        console.log('CSV数据结构:', currentCsvData);
        if (currentCsvData && currentCsvData.length > 0) {
            console.log('第一条记录:', currentCsvData[0]);
            console.log('第一条记录键值:', Object.keys(currentCsvData[0]));
            
            // 读取原始CSV文件并解析
            const reader = new FileReader();
            reader.onload = function(event) {
                const csvContent = event.target.result;
                const lines = csvContent.split('\n');
                if (lines.length > 0) {
                    console.log('原始CSV第一行:', lines[0]);
                    const fields = lines[0].split(',');
                    console.log('原始CSV字段数:', fields.length);
                    
                    // 检查第17列 (index 16)
                    if (fields.length >= 17) {
                        console.log('原始CSV第17列值:', fields[16]);
                    }
                    
                    // 解析并手动添加签证类型字段到currentCsvData
                    if (lines.length > 1) {
                        currentCsvData.forEach((record, index) => {
                            if (index < lines.length) {
                                const lineFields = lines[index].split(',');
                                if (lineFields.length >= 17) {
                                    record.visa_type = lineFields[16];
                                    console.log(`添加签证类型到记录 ${index}: ${record.visa_type}`);
                                }
                            }
                        });
                        
                        // 在添加签证类型字段后立即更新当前记录显示
                        if (currentRecordIndex < currentCsvData.length) {
                            displayCSVData(currentCsvData[currentRecordIndex]);
                        }
                        
                        // 分析签证类型分布并更新统计
                        analyzeVisaTypeDistribution(currentCsvData);
                    }
                }
                
                // 显示受理号核对模态框
                showAcceptanceNumberModal();
            };
            reader.readAsText(file);
        } else {
            // 没有CSV数据，直接显示模态框
            showAcceptanceNumberModal();
        }

        // 更新UI
        updateRecordDisplay();
        document.getElementById('prevRecord').disabled = currentRecordIndex === 0;
        document.getElementById('nextRecord').disabled = currentRecordIndex >= currentCsvData.length - 1;
        document.getElementById('recordCounter').textContent = `${currentRecordIndex + 1}/${currentCsvData.length}`;

        showSuccess('CSV文件上传成功');
    } catch (error) {
        console.error('上传CSV错误:', error);
        showError('上传文件时发生错误', error.message);
    } finally {
        hideLoading(passportInfo);
    }
}

// 护照文件上传处理函数
async function handlePassportFileUpload(e) {
    const file = e.target.files[0];
    if (!file) return;
    
    const formData = new FormData();
    formData.append('file', file);
    
    const pdfPreview = document.getElementById('pdfPreview');
    showLoading(pdfPreview);
    
    try {
        const response = await fetch('/upload/passport', {
            method: 'POST',
            body: formData
        });
        
        const result = await response.json();
        console.log('护照上传响应:', result);
        
        if (response.ok) {
            currentPdfFilename = result.pdf_filename;
            
            if (result.pdf_filename) {
                const pdfUrl = `/uploads/passports/${result.pdf_filename}`;
                displayPDFPreview(pdfUrl);
            }
            
            document.getElementById('preprocessButton').disabled = false;
            showSuccess('护照文件上传成功，请点击"一键预处理"开始处理');
        } else {
            showError(result.error || '上传失败');
        }
    } catch (error) {
        showError('上传失败', error.message);
        console.error('护照上传错误:', error);
    } finally {
        hideLoading(pdfPreview);
        e.target.value = '';
    }
}

// 照片文件上传处理函数
async function handlePhotoFilesUpload(e) {
    const files = e.target.files;
    if (!files || files.length === 0) return;
    
    const formData = new FormData();
    let totalSize = 0;
    const validFiles = [];
    const invalidFiles = [];
    
    for (let i = 0; i < files.length; i++) {
        const file = files[i];
        const ext = file.name.split('.').pop().toLowerCase();
        
        if (!['jpg', 'jpeg', 'png', 'bmp'].includes(ext)) {
            invalidFiles.push({name: file.name, reason: '不支持的文件格式'});
            continue;
        }
        
        if (file.size > 5 * 1024 * 1024) {
            invalidFiles.push({name: file.name, reason: '文件大小超过5MB'});
            continue;
        }
        
        totalSize += file.size;
        validFiles.push(file);
    }
    
    if (totalSize > 200 * 1024 * 1024) {
        showError('选择的文件总大小超过200MB限制');
        e.target.value = '';
        return;
    }
    
    if (validFiles.length === 0) {
        showError('没有有效的图片文件可以上传');
        e.target.value = '';
        return;
    }
    
    validFiles.forEach(file => {
        formData.append('files[]', file);
    });
    
    try {
        const response = await fetch('/upload/photos', {
            method: 'POST',
            body: formData
        });
        
        if (!response.ok) {
            throw new Error(`上传失败: ${response.status}`);
        }
        
        const result = await response.json();
        console.log('照片上传响应:', result);
        
        if (result.uploaded_files && result.uploaded_files.length > 0) {
            showSuccess(`成功上传 ${result.uploaded_files.length} 个文件`);
            displayPhoto(result.uploaded_files[0]);
        }
        
        if (result.errors && result.errors.length > 0) {
            showWarning('部分文件上传失败：\n' + result.errors.join('\n'));
        }
        
    } catch (error) {
        showError('上传失败', error.message);
        console.error('照片上传错误:', error);
    } finally {
        e.target.value = '';
    }
}

// 键盘快捷键控制
document.addEventListener('keydown', function(e) {
    // 如果正在输入（焦点在输入框中），不处理快捷键
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') {
        return;
    }

    // 左右方向键控制记录导航
    if (e.key === 'ArrowLeft') {
        e.preventDefault();
        showPreviousRecord();
    } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        showNextRecord();
    }

    // 空格键控制
    if (e.key === ' ') {
        e.preventDefault();
        if (e.shiftKey) {
            // Shift + 空格：跳转到第一条记录
            if (currentCsvData && currentCsvData.length > 0) {
                currentRecordIndex = 0;
                updateRecordDisplay();
            }
        } else if (currentErrorIndex !== -1) {
            // 如果当前在错误记录中，则标记/取消标记当前错误记录
            toggleMarkRecord(currentErrorIndex);
        } else {
            // 普通空格：显示下一条记录
            showNextRecord();
        }
    }

    // Ctrl + 滚轮或 Ctrl + +/- 控制缩放
    if (e.ctrlKey) {
        if (e.key === '=' || e.key === '+') {
            e.preventDefault();
            handleZoomIn(e);
        } else if (e.key === '-' || e.key === '_') {
            e.preventDefault();
            handleZoomOut(e);
        } else if (e.key === '0') {
            e.preventDefault();
            handleResetZoom(e);
        }
    }

    // Enter 键跳转到下一个错误记录
    if (e.key === 'Enter' && errorRecords.length > 0) {
        e.preventDefault();
        const nextErrorIndex = (currentErrorIndex + 1) % errorRecords.length;
        currentRecordIndex = errorRecords[nextErrorIndex].index;
        currentErrorIndex = nextErrorIndex;
        updateRecordDisplay();
    }
});

// 修改 handleWheel 函数以支持 Ctrl + 滚轮缩放
function handleWheel(e) {
    // 只有按住 Ctrl 键时才进行缩放
    if (!e.ctrlKey) {
        return;
    }
    
    // 阻止默认滚动行为
    e.preventDefault();
    e.stopPropagation();
    
    // 根据滚轮方向确定缩放方向
    const delta = e.deltaY < 0 ? 0.1 : -0.1;
    const newScale = Math.max(0.5, Math.min(3.0, currentPdfScale + delta));
    
    if (Math.abs(newScale - currentPdfScale) >= 0.01) {
        currentPdfScale = newScale;
        renderPdfPage();
    }
}

function handleMouseDown(e) {
    const container = e.currentTarget;
    isDragging = true;
    container.classList.add('grabbing');
    
    startX = e.pageX - container.offsetLeft;
    startY = e.pageY - container.offsetTop;
    scrollLeft = container.scrollLeft;
    scrollTop = container.scrollTop;
}

// 显示上一条记录
function showPreviousRecord() {
    if (currentRecordIndex > 0) {
        currentRecordIndex--;
        updateRecordDisplay();
    }
}

// 显示下一条记录
function showNextRecord() {
    if (currentCsvData && currentRecordIndex < currentCsvData.length - 1) {
        currentRecordIndex++;
        updateRecordDisplay();
    }
}

// 更新记录显示
function updateRecordDisplay() {
    if (!currentCsvData || currentCsvData.length === 0) {
        document.getElementById('recordCounter').textContent = '0/0';
        document.getElementById('prevRecord').disabled = true;
        document.getElementById('nextRecord').disabled = true;
        clearDisplayData();
        return;
    }

    const record = currentCsvData[currentRecordIndex];
    
    // 检查记录是否包含visa_type字段
    if (!record.visa_type && currentCsvData.some(item => item.visa_type)) {
        // 有些记录已有visa_type字段，但当前记录没有，尝试获取文件读取它
        console.log("当前记录缺少visa_type字段，尝试从原始文件获取");
        const csvFileInput = document.getElementById('csvFile');
        if (csvFileInput && csvFileInput.files && csvFileInput.files[0]) {
            const file = csvFileInput.files[0];
            const reader = new FileReader();
            reader.onload = function(event) {
                try {
                    const csvContent = event.target.result;
                    const lines = csvContent.split('\n');
                    if (lines.length > currentRecordIndex) {
                        const lineFields = lines[currentRecordIndex].split(',');
                        if (lineFields.length >= 17) {
                            record.visa_type = lineFields[16];
                            console.log(`为记录${currentRecordIndex}添加签证类型: ${record.visa_type}`);
                            
                            // 更新完整记录显示
                            completeRecordDisplay(record);
                            return; // 已在回调中更新，不需要继续
                        }
                    }
                } catch (e) {
                    console.error('读取CSV文件失败:', e);
                }
                
                // 如果无法获取visa_type，仍然显示记录
                completeRecordDisplay(record);
            };
            reader.readAsText(file);
            return; // 等待异步操作完成
        }
    }
    
    // 常规显示流程
    completeRecordDisplay(record);
}

// 完成记录显示的全部逻辑
function completeRecordDisplay(record) {
    // 更新计数器
    document.getElementById('recordCounter').textContent = 
        `${currentRecordIndex + 1}/${currentCsvData.length}`;
    
    // 更新按钮状态
    document.getElementById('prevRecord').disabled = currentRecordIndex === 0;
    document.getElementById('nextRecord').disabled = currentRecordIndex === currentCsvData.length - 1;
    
    // 显示 CSV 数据
    displayCSVData(record);
    
    // 如果有护照数据，找到匹配的护照数据并显示
    if (currentPassportData && currentPassportData.passport_data_list && Array.isArray(currentPassportData.passport_data_list)) {
        console.log('尝试匹配护照数据，当前记录护照号:', record.passport_number);
        
        // 没有护照号时不尝试匹配
        if (!record.passport_number) {
            console.warn('当前记录没有护照号，无法匹配护照数据');
            clearPassportData();
            clearCheckResults();
            const pdfPreview = document.getElementById('pdfPreview');
            pdfPreview.innerHTML = '<div class="no-pdf">记录缺少护照号，无法匹配</div>';
            return;
        }
        
        // 清理和规范化护照号（去除空格、大小写差异和特殊字符）
        const normalizedCsvPassportNumber = (record.passport_number || '')
            .trim()
            .toUpperCase()
            .replace(/[^A-Z0-9]/g, ''); // 移除所有非字母和数字的字符
        
        console.log('清理后的护照号:', normalizedCsvPassportNumber);
        
        // 如果清理后的护照号太短，可能不是有效的护照号
        if (normalizedCsvPassportNumber.length < 5) {
            console.warn('清理后的护照号太短，可能不是有效的护照号');
        }
        
        // 列出所有可用的护照号（清理后）
        const availablePassportNumbers = currentPassportData.passport_data_list.map(p => {
            const cleaned = (p.passport_number || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
            return { original: p.passport_number, cleaned, data: p };
        });
        
        console.log('可用护照数据列表:', availablePassportNumbers.map(p => ({ original: p.original, cleaned: p.cleaned })));
        
        // 尝试完全匹配
        let matchingPassportObj = availablePassportNumbers.find(p => p.cleaned === normalizedCsvPassportNumber);
        
        // 如果没找到，尝试部分匹配
        if (!matchingPassportObj && normalizedCsvPassportNumber.length >= 5) {
            // 首先尝试后缀匹配（护照号后面的数字部分）
            matchingPassportObj = availablePassportNumbers.find(p => {
                // 提取数字部分进行比较
                const csvNumbers = normalizedCsvPassportNumber.match(/\d+/g) || [];
                const pdNumbers = p.cleaned.match(/\d+/g) || [];
                
                // 如果双方都有数字部分，比较最长的那个数字串
                if (csvNumbers.length > 0 && pdNumbers.length > 0) {
                    const longestCsvNumber = csvNumbers.reduce((a, b) => a.length > b.length ? a : b);
                    const longestPdNumber = pdNumbers.reduce((a, b) => a.length > b.length ? a : b);
                    
                    // 如果数字部分相同，认为是匹配的
                    if (longestCsvNumber === longestPdNumber && longestCsvNumber.length >= 5) {
                        return true;
                    }
                }
                
                // 否则检查包含关系
                return (p.cleaned.length >= 5 && normalizedCsvPassportNumber.includes(p.cleaned)) || 
                       (normalizedCsvPassportNumber.length >= 5 && p.cleaned.includes(normalizedCsvPassportNumber));
            });
            
            if (matchingPassportObj) {
                console.log('通过部分匹配/数字匹配找到护照数据:', matchingPassportObj.original);
            }
        }
        
        let matchingPassport = matchingPassportObj?.data;
        
        if (matchingPassport) {
            console.log('找到匹配的护照数据:', matchingPassport);
        } else {
            console.warn('未找到匹配的护照数据，请检查护照号格式是否一致');
        }
        
        displayPassportData(matchingPassport);
        displayCheckResults(record, matchingPassport);
        
        if (matchingPassport && currentPdfFilename) {
            const pdfUrl = `/uploads/passports/${currentPdfFilename}`;
            const pageNumber = matchingPassport.page_number || 1;
            // 使用辅助函数加载PDF，考虑是否需要强制刷新
            loadPdfWithCheck(pdfUrl, pageNumber);
        } else {
            const pdfPreview = document.getElementById('pdfPreview');
            if (!matchingPassport) {
                pdfPreview.innerHTML = `
                    <div class="no-pdf">
                        <div class="alert alert-warning">未找到护照号为 "${record.passport_number}" 的护照数据</div>
                        <div class="small text-muted mt-2">可能原因：</div>
                        <ul class="small text-muted">
                            <li>护照号格式不匹配，请检查是否有多余的空格或特殊字符</li>
                            <li>护照PDF未包含该护照，或OCR识别失败</li>
                            <li>预处理未成功完成，请尝试重新预处理</li>
                        </ul>
                    </div>
                `;
            } else {
                pdfPreview.innerHTML = '<div class="no-pdf">未能加载PDF，请检查文件是否存在</div>';
            }
        }
    } else {
        clearPassportData();
        clearCheckResults();
        const pdfPreview = document.getElementById('pdfPreview');
        pdfPreview.innerHTML = '<div class="no-pdf">未找到护照数据</div>';
    }
    
    // 更新照片显示
    if (record.photo_filename) {
        displayPhoto(record.photo_filename);
    } else {
        displayPhoto(null);
    }

    // 更新错误记录高亮
    if (errorRecords.length > 0) {
        currentErrorIndex = errorRecords.findIndex(record => record.index === currentRecordIndex);
        updateErrorRecordsDisplay();
    }
}

// 显示照片
function displayPhoto(filename) {
    const photoContainer = document.querySelector('.photo-container');
    if (!photoContainer) {
        console.error('找不到照片容器元素');
        return;
    }
    
    // 清空之前的内容
    photoContainer.innerHTML = '';
    
    if (!filename) {
        photoContainer.innerHTML = '<div class="no-photo">无照片</div>';
        console.log('无照片文件名');
        return;
    }

    // 清理文件名
    let cleanFilename = filename.trim();
    
    // 检查文件名是否为空
    if (!cleanFilename) {
        console.error('文件名为空');
        photoContainer.innerHTML = '<div class="no-photo">无效的文件名</div>';
        return;
    }
    
    // 移除路径分隔符
    cleanFilename = cleanFilename.split(/[/\\]/).pop();
    
    // 检查文件扩展名
    const ext = cleanFilename.split('.').pop().toLowerCase();
    if (!['jpg', 'jpeg', 'png', 'bmp'].includes(ext)) {
        console.error('不支持的文件类型:', ext);
        photoContainer.innerHTML = '<div class="no-photo">不支持的文件类型</div>';
        return;
    }
    
    console.log('原始文件名:', filename);
    console.log('处理后的文件名:', cleanFilename);

    // 创建加载提示
    const loadingDiv = document.createElement('div');
    loadingDiv.className = 'loading-indicator';
    loadingDiv.textContent = '正在加载照片...';
    photoContainer.appendChild(loadingDiv);

    // 创建新的图片元素
    const img = new Image();
    
    // 构建图片URL时确保使用正确的编码
    const imageUrl = `/uploads/photos/${encodeURIComponent(cleanFilename)}`;
    console.log('尝试加载图片URL:', imageUrl);
    
    img.onload = () => {
        console.log('照片加载成功:', cleanFilename);
        if (photoContainer.contains(loadingDiv)) {
            photoContainer.removeChild(loadingDiv);
        }
        img.className = 'photo-preview-img';
        photoContainer.appendChild(img);
    };
    
    img.onerror = (error) => {
        console.error('照片加载失败:', cleanFilename, error);
        photoContainer.innerHTML = `
            <div class="no-photo">
                照片加载失败<br>
                <small>文件名: ${cleanFilename}</small><br>
                <small>请确保照片已正确上传</small>
            </div>
        `;
    };

    img.src = imageUrl;
    img.alt = '证件照';
}

// 显示PDF预览并检查是否应强制刷新
function loadPdfWithCheck(pdfUrl, pageNumber) {
    // 检查全局状态和参数
    const shouldForce = shouldForcePdfReload;
    
    // 如果需要强制刷新，使用时间戳破坏缓存
    displayPDFPreview(pdfUrl, pageNumber, shouldForce);
    
    // 使用一次后重置标志
    shouldForcePdfReload = false;
}

// 显示PDF预览
function displayPDFPreview(pdfUrl, pageNumber = 1, forceReload = false) {
    console.log('开始加载PDF:', pdfUrl, '页码:', pageNumber, '强制刷新:', forceReload);
    const pdfPreview = document.getElementById('pdfPreview');
    
    if (!pdfUrl) {
        pdfPreview.innerHTML = '<div class="no-pdf">未找到护照数据</div>';
        return;
    }

    // 清除现有内容
    pdfPreview.innerHTML = '';

    // 创建缩放控制按钮容器
    const controlsHtml = `
        <div class="pdf-controls">
            <button id="zoomIn" class="zoom-btn" title="放大">+</button>
            <span id="zoomLevel">100%</span>
            <button id="zoomOut" class="zoom-btn" title="缩小">-</button>
            <button id="resetZoom" class="zoom-btn" title="重置缩放">↺</button>
        </div>
    `;
    pdfPreview.insertAdjacentHTML('beforeend', controlsHtml);

    // 创建 canvas 容器
    const canvasContainer = document.createElement('div');
    canvasContainer.className = 'canvas-container';
    pdfPreview.appendChild(canvasContainer);
    
    // 添加加载提示
    const loadingDiv = document.createElement('div');
    loadingDiv.className = 'loading-pdf';
    loadingDiv.textContent = '正在加载PDF...';
    canvasContainer.appendChild(loadingDiv);

    // 防止缓存，添加时间戳
    const cacheBustUrl = pdfUrl.includes('?') ? 
        `${pdfUrl}&_t=${Date.now()}` : 
        `${pdfUrl}?_t=${Date.now()}`;

    // 使用 PDF.js 加载 PDF
    pdfjsLib.getDocument({
        url: forceReload || shouldForcePdfReload ? cacheBustUrl : pdfUrl, // 根据参数或全局状态决定是否使用缓存破坏
        cMapUrl: 'https://cdn.jsdelivr.net/npm/pdfjs-dist@2.12.313/cmaps/',
        cMapPacked: true
    }).promise
        .then(pdf => {
            console.log('PDF 加载成功，总页数:', pdf.numPages);
            // 移除加载提示
            if (canvasContainer.contains(loadingDiv)) {
                canvasContainer.removeChild(loadingDiv);
            }
            
            // 确保页码有效
            const validPageNumber = Math.min(Math.max(1, pageNumber), pdf.numPages);
            if (validPageNumber !== pageNumber) {
                console.warn(`请求的页码 ${pageNumber} 无效，使用页码 ${validPageNumber}`);
            }
            
            return pdf.getPage(validPageNumber);
        })
        .then(page => {
            console.log('成功获取页面');
            currentPdfPage = page;
            currentPdfScale = 1.0;
            bindZoomEvents();
            requestAnimationFrame(renderPdfPage);
        })
        .catch(error => {
            console.error('PDF 加载失败:', error);
            canvasContainer.innerHTML = '';
            
            // 更具体的错误信息显示
            let errorMessage = '加载PDF失败';
            if (error.name === 'MissingPDFException') {
                errorMessage = 'PDF文件不存在或无法访问';
            } else if (error.name === 'InvalidPDFException') {
                errorMessage = 'PDF文件格式无效或已损坏';
            } else if (error.name === 'PasswordException') {
                errorMessage = 'PDF文件受密码保护';
            } else if (error.message) {
                errorMessage = `加载失败: ${error.message}`;
            }
            
            pdfPreview.innerHTML = `
                <div class="no-pdf">
                    <div class="pdf-error">${errorMessage}</div>
                    <div class="pdf-error-details">
                        <p>请尝试重新上传PDF文件或刷新页面</p>
                        <button onclick="location.reload()" class="btn btn-sm btn-outline-primary">刷新页面</button>
                    </div>
                </div>
            `;
        });
}

// 显示 CSV 数据
function displayCSVData(record) {
    if (!record) {
        clearCSVData();
        return;
    }

    console.log('显示 CSV 记录:', record);
    
    // 更新 CSV 数据显示
    document.getElementById('csv-passport-number').textContent = record.passport_number || '无数据';
    document.getElementById('csv-name').textContent = `${record.surname || ''} ${record.given_name || ''}`.trim() || '无数据';
    document.getElementById('csv-gender').textContent = record.gender || '无数据';
    document.getElementById('csv-birth-date').textContent = formatDate(record.birth_date) || '无数据';
    document.getElementById('csv-expiry-date').textContent = formatDate(record.expiry_date) || '无数据';
    
    // 获取签证类型 - 优先使用已添加的visa_type字段
    let visaType = '未知';
    try {
        // 首先检查是否存在visa_type字段
        if (record.visa_type) {
            visaType = record.visa_type;
            console.log(`使用visa_type字段: ${visaType}`);
        } else {
            console.log('未找到visa_type字段，尝试从原始数据获取');
            
            // 尝试直接获取原始CSV数据
            if (currentCsvData && currentCsvData.length > 0) {
                // 查找当前记录在原始数据中的索引
                const index = currentCsvData.findIndex(item => 
                    item.passport_number === record.passport_number && 
                    item.index === record.index
                );
                
                if (index !== -1 && record === currentCsvData[index]) {
                    // 如果还没有添加visa_type字段，尝试读取原始CSV文件
                    const csvFileInput = document.getElementById('csvFile');
                    if (csvFileInput && csvFileInput.files && csvFileInput.files[0]) {
                        const file = csvFileInput.files[0];
                        const reader = new FileReader();
                        reader.onload = function(event) {
                            try {
                                const csvContent = event.target.result;
                                const lines = csvContent.split('\n');
                                if (lines.length > index && index >= 0) {
                                    const lineFields = lines[index].split(',');
                                    if (lineFields.length >= 17) {
                                        record.visa_type = lineFields[16];
                                        console.log(`从原始CSV获取并添加签证类型: ${record.visa_type}`);
                                        
                                        // 更新UI
                                        updateVisaTypeDisplay(record.visa_type);
                                    }
                                }
                            } catch (e) {
                                console.error('读取原始CSV文件失败:', e);
                            }
                        };
                        reader.readAsText(file);
                    }
                }
            }
        }
    } catch (e) {
        console.error('获取签证类型失败:', e);
    }
    
    // 显示签证类型
    updateVisaTypeDisplay(visaType);
    
    // 更新受理号显示
    document.getElementById('applicationNumber').textContent = record.index || '无数据';
    // 更新中文姓名显示
    document.getElementById('chineseName').textContent = record.chinese_name || '无数据';
}

// 辅助函数：更新签证类型显示
function updateVisaTypeDisplay(visaType) {
    const visaTypeElement = document.getElementById('visaType');
    if (visaTypeElement) {
        // 根据签证类型设置样式
        if (isVisa3MFormat(visaType)) {
            visaTypeElement.className = 'badge bg-info';
            visaTypeElement.textContent = '3M';
        } else if (isVisa5MFormat(visaType)) {
            visaTypeElement.className = 'badge bg-success';
            visaTypeElement.textContent = '5M';
        } else {
            visaTypeElement.className = 'badge bg-secondary';
            visaTypeElement.textContent = visaType || '未知';
        }
    }
}

// 显示护照识别数据
function displayPassportData(data) {
    if (!data) {
        clearPassportData();
        return;
    }

    console.log('显示护照数据:', data);

    // 更新护照识别数据显示
    document.getElementById('ocr-passport-number').textContent = data.passport_number || '无数据';
    document.getElementById('ocr-name').textContent = `${data.surname || ''} ${data.given_name || ''}`.trim() || '无数据';
    document.getElementById('ocr-gender').textContent = data.gender || '无数据';
    document.getElementById('ocr-birth-date').textContent = formatDate(data.birth_date) || '无数据';
    document.getElementById('ocr-expiry-date').textContent = formatDate(data.expiry_date) || '无数据';

    // 如果护照数据中有中文姓名，也更新显示
    if (data.chinese_name) {
        document.getElementById('chineseName').textContent = data.chinese_name;
    }
}

// 显示检查结果
function displayCheckResults(csvRecord, passportData) {
    if (!csvRecord || !passportData) {
        clearCheckResults();
        return;
    }

    const fields = [
        { key: 'passport_number', element: 'check-passport-number' },
        { key: 'name', element: 'check-name', compare: (csv, passport) => 
            `${csv.surname} ${csv.given_name}`.trim() === `${passport.surname} ${passport.given_name}`.trim() },
        { key: 'gender', element: 'check-gender' },
        { key: 'birth_date', element: 'check-birth-date' },
        { key: 'expiry_date', element: 'check-expiry-date' }
    ];

    fields.forEach(field => {
        const element = document.getElementById(field.element);
        if (field.key === 'name') {
            const isMatch = field.compare(csvRecord, passportData);
            element.textContent = isMatch ? '✓' : '✗';
            element.className = `check-result ${isMatch ? 'success' : 'error'}`;
        } else {
            const isMatch = csvRecord[field.key] === passportData[field.key];
            element.textContent = isMatch ? '✓' : '✗';
            element.className = `check-result ${isMatch ? 'success' : 'error'}`;
        }
    });
}

// 清除所有显示数据
function clearDisplayData() {
    clearCSVData();
    clearPassportData();
    clearCheckResults();
}

// 清除 CSV 数据显示
function clearCSVData() {
    console.log('清除 CSV 数据显示');
    
    const fields = ['passport-number', 'name', 'gender', 'birth-date', 'expiry-date'];
    fields.forEach(field => {
        const element = document.getElementById(`csv-${field}`);
        if (element) {
            element.textContent = '无数据';
        } else {
            console.error(`未找到元素: csv-${field}`);
        }
    });
    
    // 清除受理号和中文姓名显示
    const applicationNumber = document.getElementById('applicationNumber');
    const chineseName = document.getElementById('chineseName');
    
    if (applicationNumber) {
        applicationNumber.textContent = '无数据';
    } else {
        console.error('未找到元素: applicationNumber');
    }
    
    if (chineseName) {
        chineseName.textContent = '无数据';
    } else {
        console.error('未找到元素: chineseName');
    }
}

// 清除护照数据显示
function clearPassportData() {
    const fields = ['passport-number', 'name', 'gender', 'birth-date', 'expiry-date'];
    fields.forEach(field => {
        const element = document.getElementById(`ocr-${field}`);
        if (element) {
            element.textContent = '无数据';
        }
    });
}

// 清除检查结果显示
function clearCheckResults() {
    const fields = ['passport-number', 'name', 'gender', 'birth-date', 'expiry-date'];
    fields.forEach(field => {
        const element = document.getElementById(`check-${field}`);
        if (element) {
            element.textContent = '-';
            element.className = 'check-result';
        }
    });
}

// 格式化日期显示
function formatDate(dateStr) {
    if (!dateStr) return '';
    // 如果日期格式是 YYYYMMDD，转换为 YYYY/MM/DD
    if (dateStr.length === 8) {
        return `${dateStr.slice(0, 4)}/${dateStr.slice(4, 6)}/${dateStr.slice(6, 8)}`;
    }
    return dateStr;
}

// 预处理函数
async function startPreprocessing() {
    if (!currentPdfFilename || isProcessing) {
        return;
    }
    
    isProcessing = true;
    const preprocessButton = document.getElementById('preprocessButton');
    const progressBar = document.getElementById('progressBar');
    const progressStatus = document.getElementById('progressStatus');
    
    preprocessButton.disabled = true;
    progressBar.style.display = 'block';
    progressBar.value = 0;
    
    try {
        // 首先检查是否有缓存
        const checkCacheResponse = await fetch('/api/check_cache', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                pdf_filename: currentPdfFilename
            })
        });
        
        const cacheResult = await checkCacheResponse.json();
        let shouldForceReprocess = false;
        
        // 只有当存在有效缓存时才询问是否强制重新处理
        if (cacheResult.has_cache) {
            shouldForceReprocess = confirm('检测到已有缓存数据，是否强制重新处理？\n\n选择"确定"将重新调用Coze API处理，选择"取消"将使用缓存数据。');
        }
        
        // 设置全局PDF刷新标志
        shouldForcePdfReload = shouldForceReprocess;
        
        console.log(`开始预处理护照 ${currentPdfFilename}，强制重新处理: ${shouldForceReprocess}`);
        
        const response = await fetch('/preprocess/passport', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                pdf_filename: currentPdfFilename,
                force_reprocess: shouldForceReprocess
            })
        });
        
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        
        const reader = response.body.getReader();
        let isFromCache = false;
        let receivedPassportData = false; // 标记是否接收到有效的护照数据
        
        while (true) {
            const {value, done} = await reader.read();
            
            if (done) {
                break;
            }
            
            // 解析进度消息
            const text = new TextDecoder().decode(value);
            const messages = text.split('\n').filter(msg => msg.trim());
            
            for (const msg of messages) {
                try {
                    const data = JSON.parse(msg);
                    if (data.from_cache) {
                        isFromCache = true;
                        console.log('从缓存加载数据', data);
                    }
                    
                    if (data.progress) {
                        progressBar.value = data.progress;
                    }
                    
                    if (data.status) {
                        progressStatus.textContent = data.status;
                    }
                    
                    if (data.error) {
                        console.error('预处理过程中发生错误:', data.error);
                        throw new Error(data.error);
                    }
                    
                    // 检查是否有护照数据
                    if (data.passport_data_list) {
                        // 验证护照数据结构是否有效
                        if (!Array.isArray(data.passport_data_list)) {
                            console.error('护照数据不是数组:', data.passport_data_list);
                            throw new Error('返回的护照数据格式无效');
                        }
                        
                        if (data.passport_data_list.length === 0) {
                            console.warn('返回的护照数据数组为空');
                        } else {
                            receivedPassportData = true; // 标记收到有效数据
                            console.log(`接收到${data.passport_data_list.length}条护照数据`);
                            
                            // 更新整个护照数据列表
                            currentPassportData = {
                                passport_data_list: data.passport_data_list,
                                valid_pages: data.valid_pages || []
                            };
                            
                            // 添加详细的调试日志
                            console.log('获取到护照数据列表:', data.passport_data_list);
                            console.log('护照数据数量:', data.passport_data_list.length);
                            
                            if (data.passport_data_list.length > 0) {
                                console.log('第一条护照数据护照号:', data.passport_data_list[0].passport_number);
                                
                                // 如果有CSV数据，检查是否能匹配
                                if (currentCsvData && currentCsvData.length > 0) {
                                    console.log('当前CSV数据数量:', currentCsvData.length);
                                    console.log('当前CSV第一条数据护照号:', currentCsvData[0].passport_number);
                                    
                                    // 检查是否有匹配的护照号
                                    const matchCount = currentCsvData.filter(csv => 
                                        data.passport_data_list.some(p => p.passport_number === csv.passport_number)
                                    ).length;
                                    
                                    console.log(`CSV数据中能匹配护照数据的记录数: ${matchCount}/${currentCsvData.length}`);
                                    
                                    if (matchCount === 0) {
                                        console.warn('未找到匹配的护照数据，请检查护照号格式');
                                    }
                                }
                            }
                        }
                    }
                } catch (e) {
                    console.error('解析进度消息失败:', e);
                }
            }
        }
        
        // 处理完成检查
        if (!receivedPassportData) {
            console.error('预处理完成但未收到有效的护照数据');
            throw new Error('预处理过程未返回有效的护照数据，请重试');
        }
        
        showSuccess(isFromCache ? '从缓存加载护照数据完成' : '护照预处理完成');
        
        // 如果是从缓存加载，确保数据显示正确
        if (currentPassportData && currentPassportData.passport_data_list) {
            console.log('检查护照数据:', currentPassportData);
            
            // 检查当前CSV数据中的护照号与护照数据的匹配情况
            if (currentCsvData && currentCsvData.length > 0) {
                // 添加延迟确保数据加载完成后更新显示
                setTimeout(() => {
                    console.log('预处理后刷新显示');
                    updateRecordDisplay();
                }, 500);
            }
        }
    } catch (error) {
        // 重置护照数据以避免使用部分处理的数据
        currentPassportData = null;
        
        showError('预处理失败', error.message);
        console.error('预处理错误:', error);
    } finally {
        isProcessing = false;
        preprocessButton.disabled = false;
        progressBar.style.display = 'none';
        progressStatus.textContent = '';
    }
}

// 绑定缩放事件
function bindZoomEvents() {
    console.log('绑定缩放事件');
    const zoomInBtn = document.getElementById('zoomIn');
    const zoomOutBtn = document.getElementById('zoomOut');
    const resetZoomBtn = document.getElementById('resetZoom');
    const canvasContainer = document.querySelector('.canvas-container');

    if (zoomInBtn) {
        zoomInBtn.onclick = handleZoomIn;
    }

    if (zoomOutBtn) {
        zoomOutBtn.onclick = handleZoomOut;
    }

    if (resetZoomBtn) {
        resetZoomBtn.onclick = handleResetZoom;
    }

    if (canvasContainer) {
        canvasContainer.onwheel = handleWheel;
        canvasContainer.onmousedown = handleMouseDown;
        document.onmousemove = handleMouseMove;
        document.onmouseup = handleMouseUp;
    }
}

// 处理鼠标移动
function handleMouseMove(e) {
    if (!isDragging) return;
    
    e.preventDefault();
    const container = document.querySelector('.canvas-container');
    if (!container) return;
    
    const x = e.pageX - container.offsetLeft;
    const y = e.pageY - container.offsetTop;
    const walkX = (x - startX);
    const walkY = (y - startY);
    
    container.scrollLeft = scrollLeft - walkX;
    container.scrollTop = scrollTop - walkY;
}

// 处理鼠标松开
function handleMouseUp() {
    isDragging = false;
    const container = document.querySelector('.canvas-container');
    if (container) {
        container.classList.remove('grabbing');
    }
}

// 处理放大按钮点击
function handleZoomIn(e) {
    e.preventDefault();
    e.stopPropagation();
    
    const newScale = Math.min(3.0, currentPdfScale + 0.1);
    if (Math.abs(newScale - currentPdfScale) >= 0.01) {
        currentPdfScale = newScale;
        renderPdfPage();
    }
}

// 处理缩小按钮点击
function handleZoomOut(e) {
    e.preventDefault();
    e.stopPropagation();
    
    const newScale = Math.max(0.5, currentPdfScale - 0.1);
    if (Math.abs(newScale - currentPdfScale) >= 0.01) {
        currentPdfScale = newScale;
        renderPdfPage();
    }
}

// 处理重置缩放按钮点击
function handleResetZoom(e) {
    e.preventDefault();
    e.stopPropagation();
    
    if (Math.abs(currentPdfScale - 1.0) >= 0.01) {
        currentPdfScale = 1.0;
        renderPdfPage();
    }
}

// 渲染PDF页面
function renderPdfPage() {
    if (!currentPdfPage) {
        console.error('没有可用的 PDF 页面');
        return;
    }

    const canvasContainer = document.querySelector('.canvas-container');
    if (!canvasContainer) {
        console.error('找不到 canvas 容器');
        return;
    }

    // 保存当前滚动位置和视图中心点
    const containerRect = canvasContainer.getBoundingClientRect();
    const oldCanvas = canvasContainer.querySelector('canvas');
    const oldScrollLeft = canvasContainer.scrollLeft;
    const oldScrollTop = canvasContainer.scrollTop;
    
    // 如果存在旧的canvas，计算中心点位置
    let centerXPercent = 0.5, centerYPercent = 0.5;
    if (oldCanvas) {
        const oldRect = oldCanvas.getBoundingClientRect();
        centerXPercent = (oldScrollLeft + containerRect.width / 2) / oldRect.width;
        centerYPercent = (oldScrollTop + containerRect.height / 2) / oldRect.height;
    }

    // 创建新的 canvas
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d', {
        alpha: false,
        willReadFrequently: true
    });

    // 计算新的视口尺寸
    const viewport = currentPdfPage.getViewport({ scale: currentPdfScale });
    
    // 设置canvas的实际尺寸
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    
    // 设置canvas的显示尺寸，与实际尺寸保持一致
    canvas.style.width = `${viewport.width}px`;
    canvas.style.height = `${viewport.height}px`;

    // 更新缩放显示
    const zoomLevelElement = document.getElementById('zoomLevel');
    if (zoomLevelElement) {
        zoomLevelElement.textContent = `${Math.round(currentPdfScale * 100)}%`;
    }

    // 渲染PDF页面 - 修复选项配置
    const renderContext = {
        canvasContext: context,
        viewport: viewport,
        enableWebGL: true,
        // 使用annotationMode替代弃用的renderInteractiveForms
        annotationMode: 0 // 0 = DISABLE, 1 = ENABLE, 2 = ENABLE_FORMS
    };

    currentPdfPage.render(renderContext).promise
        .then(() => {
            // 清空容器并添加新的 canvas
            canvasContainer.innerHTML = '';
            canvasContainer.appendChild(canvas);

            // 计算并设置新的滚动位置
            const newScrollLeft = (viewport.width * centerXPercent) - (containerRect.width / 2);
            const newScrollTop = (viewport.height * centerYPercent) - (containerRect.height / 2);

            // 立即滚动到新位置
            canvasContainer.scrollTo({
                left: Math.max(0, newScrollLeft),
                top: Math.max(0, newScrollTop),
                behavior: 'instant'
            });
        })
        .catch(error => {
            console.error('渲染PDF页面失败:', error);
        });
}

// 全部检查按钮点击事件处理
async function checkAllRecords() {
    if (!currentCsvData) {
        showWarning('请先上传CSV文件');
        return;
    }
    
    if (!currentPdfFilename) {
        showWarning('请先上传护照PDF文件');
        return;
    }
    
    // 检查currentPassportData是否为null或未定义
    if (!currentPassportData) {
        showWarning('护照数据不可用，请先进行预处理');
        return;
    }
    
    // 检查passport_data_list是否存在
    if (!currentPassportData.passport_data_list || !Array.isArray(currentPassportData.passport_data_list)) {
        showWarning('护照数据格式不正确，请重新进行预处理');
        return;
    }

    // 如果已在处理中，则不再启动新的处理
    if (isProcessing) {
        showWarning('系统正在处理中，请等待...');
        return;
    }

    const checkAllBtn = document.getElementById('checkAllButton');
    const progressBar = document.getElementById('progressBar');
    const progressStatus = document.getElementById('progressStatus');

    checkAllBtn.disabled = true;
    progressBar.style.display = 'block';
    progressBar.value = 0;
    progressStatus.textContent = '开始检查...';

    try {
        errorRecords = [];
        let totalRecords = currentCsvData.length;
        let processedCount = 0;

        for (let i = 0; i < currentCsvData.length; i++) {
            const csvRecord = currentCsvData[i];
            const matchingPassport = currentPassportData.passport_data_list.find(
                p => p.passport_number === csvRecord.passport_number
            );

            // 检查是否存在不匹配
            const errors = [];
            
            if (!matchingPassport) {
                errors.push('未找到对应的护照数据');
            } else {
                // 检查各个字段
                if (csvRecord.passport_number !== matchingPassport.passport_number) {
                    errors.push('护照号码不匹配');
                }
                if (`${csvRecord.surname} ${csvRecord.given_name}`.trim() !== 
                    `${matchingPassport.surname} ${matchingPassport.given_name}`.trim()) {
                    errors.push('姓名不匹配');
                }
                if (csvRecord.gender !== matchingPassport.gender) {
                    errors.push('性别不匹配');
                }
                if (csvRecord.birth_date !== matchingPassport.birth_date) {
                    errors.push('出生日期不匹配');
                }
                if (csvRecord.expiry_date !== matchingPassport.expiry_date) {
                    errors.push('到期日期不匹配');
                }
            }

            // 如果有错误，添加到错误记录中
            if (errors.length > 0) {
                errorRecords.push({
                    index: i,
                    passport_number: csvRecord.passport_number,
                    errors: errors,
                    page_number: matchingPassport ? matchingPassport.page_number : null
                });
            }

            // 更新进度
            processedCount++;
            const progress = Math.round((processedCount / totalRecords) * 100);
            progressBar.value = progress;
            progressStatus.textContent = `正在检查... ${processedCount}/${totalRecords}`;
        }

        // 更新错误记录显示
        updateErrorRecordsDisplay();

        // 显示检查结果
        if (errorRecords.length === 0) {
            showSuccess('检查完成，未发现错误');
        } else {
            showWarning(`检查完成，发现 ${errorRecords.length} 条记录存在问题`);
        }

    } catch (error) {
        showError('检查过程中发生错误', error.message);
        console.error('检查错误:', error);
    } finally {
        checkAllBtn.disabled = false;
        progressBar.style.display = 'none';
        progressStatus.textContent = '';
    }
}

// 更新错误记录显示
function updateErrorRecordsDisplay() {
    const errorRecordsContainer = document.getElementById('errorRecords');
    if (!errorRecordsContainer) return;

    errorRecordsContainer.innerHTML = '';

    if (errorRecords.length === 0) {
        errorRecordsContainer.innerHTML = '<div class="no-errors">没有发现错误</div>';
        return;
    }

    // 添加批量操作按钮
    const batchOperations = document.createElement('div');
    batchOperations.className = 'batch-operations';
    batchOperations.innerHTML = `
        <button class="btn btn-sm btn-outline-primary" onclick="markAllErrors()">全部标记</button>
        <button class="btn btn-sm btn-outline-secondary" onclick="clearErrorMarks()">清除标记</button>
        <div class="error-stats">
            <span>总计: ${errorRecords.length}</span>
            <span>已标记: ${markedRecords.size}</span>
        </div>
    `;
    errorRecordsContainer.appendChild(batchOperations);

    // 显示错误记录
    errorRecords.forEach((record, index) => {
        const recordDiv = document.createElement('div');
        const classes = ['error-record-item'];
        if (index === currentErrorIndex) classes.push('active');
        if (markedRecords.has(index)) classes.push('marked');
        recordDiv.className = classes.join(' ');
        
        recordDiv.innerHTML = `
            <div class="record-header">
                <span>护照号: ${record.passport_number || '未知'}</span>
                <button class="mark-button" onclick="toggleMarkRecord(${index})">${markedRecords.has(index) ? '已标记' : '标记'}</button>
            </div>
            <div class="record-content">
                <div>位置: 第 ${record.index + 1} 条记录</div>
                <div>页码: ${record.page_number ? `第 ${record.page_number} 页` : '未找到'}</div>
                <div class="error-type">错误: ${record.errors.join(', ')}</div>
            </div>
        `;

        recordDiv.onclick = (e) => {
            // 如果点击的是标记按钮，不进行导航
            if (e.target.classList.contains('mark-button')) {
                return;
            }
            currentRecordIndex = record.index;
            currentErrorIndex = index;
            updateRecordDisplay();
            updateErrorRecordsDisplay();
        };

        errorRecordsContainer.appendChild(recordDiv);
    });
}

// 标记所有错误记录
function markAllErrors() {
    errorRecords.forEach((_, index) => {
        markedRecords.add(index);
    });
    updateErrorRecordsDisplay();
}

// 清除错误记录的所有标记
function clearErrorMarks() {
    console.log('清除错误记录标记...');
    console.log('清除前标记数量:', markedRecords.size);
    
    markedRecords.clear();
    console.log('清除后标记数量:', markedRecords.size);
    
    // 更新显示
    updateErrorRecordsDisplay();
}

// 标记/取消标记错误记录
function toggleMarkRecord(index) {
    if (markedRecords.has(index)) {
        markedRecords.delete(index);
    } else {
        markedRecords.add(index);
    }
    updateErrorRecordsDisplay();
}

// 错误信息复核功能
async function recheckErrors() {
    if (!currentPdfFilename || !errorRecords || errorRecords.length === 0) {
        showWarning('没有需要复核的错误记录');
        return;
    }

    const recheckBtn = document.getElementById('recheckButton');
    const progressBar = document.getElementById('progressBar');
    const progressStatus = document.getElementById('progressStatus');

    recheckBtn.disabled = true;
    progressBar.style.display = 'block';
    progressBar.value = 0;
    progressStatus.textContent = '开始复核...';

    try {
        // 准备需要复核的记录
        const recordsToRecheck = errorRecords.filter(record => markedRecords.has(errorRecords.indexOf(record)));
        
        if (recordsToRecheck.length === 0) {
            showWarning('请先标记需要复核的记录');
            return;
        }

        // 发送复核请求
        const response = await fetch('/recheck/errors', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                pdf_filename: currentPdfFilename,
                records: recordsToRecheck
            })
        });

        if (!response.ok) {
            throw new Error(`复核请求失败: ${response.status}`);
        }

        const result = await response.json();
        
        if (result.error) {
            throw new Error(result.error);
        }

        // 更新护照数据
        if (result.updated_records && result.updated_records.length > 0) {
            // 更新护照数据列表中的记录
            result.updated_records.forEach(updatedRecord => {
                const index = currentPassportData.passport_data_list.findIndex(
                    p => p.passport_number === updatedRecord.passport_number
                );
                if (index !== -1) {
                    currentPassportData.passport_data_list[index] = updatedRecord;
                } else {
                    currentPassportData.passport_data_list.push(updatedRecord);
                }
            });

            // 清除已复核的记录的标记
            markedRecords.clear();

            // 重新检查所有记录
            await checkAllRecords();

            showSuccess(`成功复核 ${result.updated_records.length} 条记录`);
        } else {
            showWarning('没有记录需要更新');
        }

    } catch (error) {
        showError('复核过程中发生错误', error.message);
        console.error('复核错误:', error);
    } finally {
        recheckBtn.disabled = false;
        progressBar.style.display = 'none';
        progressStatus.textContent = '';
    }
}

// 显示受理号核对模态框
function showAcceptanceNumberModal() {
    try {
        // 清除旧的渲染函数
        window.currentRenderFunction = null;
        
        // 检查元素是否存在
        const modalElement = document.getElementById('acceptanceNumberModal');
        if (!modalElement) {
            throw new Error("找不到模态框元素");
        }
        
        const analysisContent = document.getElementById('analysisContent');
        const tableBody = document.getElementById('acceptanceNumberTableBody');
        
        if (!analysisContent || !tableBody) {
            throw new Error("找不到必要的容器元素");
        }
        
        // 清空并重置标记状态
        markedAcceptanceNumbers = new Set();
        // 重置高亮受理号数组
        highlightedAcceptanceNumbers = [];
        
        // 显示加载信息
        analysisContent.innerHTML = '<div class="alert alert-info">正在加载受理号数据...</div>';
        tableBody.innerHTML = '';
        
        // 显示当前CSV数据量
        if (currentCsvData) {
            console.log(`当前CSV记录数: ${currentCsvData.length}`);
        } else {
            console.log("当前没有CSV数据");
        }
        
        // 从API获取受理号数据
        console.log("开始请求受理号数据...");
        
        fetch('/api/get_acceptance_numbers')
            .then(response => response.json())
            .then(data => {
                if (data.success && data.data && data.data.length > 0) {
                    console.log(`API返回了${data.data.length}个受理号`);
                    return processAcceptanceData(data.data);
                } else {
                    console.log("API未返回受理号数据，尝试使用备份数据");
                    // 尝试从CSV数据中提取
                    if (currentCsvData && currentCsvData.length > 0) {
                        const backupData = extractBackupAcceptanceData();
                        if (backupData.length > 0) {
                            console.log(`提取了${backupData.length}个备份受理号数据`);
                            return processAcceptanceData(backupData);
                        } else {
                            throw new Error("无法提取备份受理号数据");
                        }
                    } else {
                        throw new Error("没有可用的CSV数据用于提取受理号");
                    }
                }
            })
            .catch(error => {
                console.error("获取受理号数据失败:", error);
                
                // 显示加载失败消息
                analysisContent.innerHTML = `
                    <div class="alert alert-danger">
                        <h5>获取受理号数据失败</h5>
                        <p>${error.message || '未知错误'}</p>
                        <p>将尝试使用备份数据。</p>
                    </div>
                `;
                
                // 尝试使用备份数据
                if (currentCsvData && currentCsvData.length > 0) {
                    try {
                        const backupData = extractBackupAcceptanceData();
                        if (backupData.length > 0) {
                            console.log(`提取了${backupData.length}个备份受理号数据`);
                            return processAcceptanceData(backupData);
                        } else {
                            throw new Error("无法提取备份受理号数据");
                        }
                    } catch (extractError) {
                        console.error("提取备份数据失败:", extractError);
                        analysisContent.innerHTML += `
                            <div class="alert alert-danger">
                                <p>提取备份数据失败: ${extractError.message || '未知错误'}</p>
                                <p>请上传包含受理号的CSV文件。</p>
                            </div>
                        `;
                        
                        // 尝试显示模态框
                        try {
                            const modal = new bootstrap.Modal(modalElement);
                            modal.show();
                        } catch (modalError) {
                            console.error("显示模态框失败:", modalError);
                        }
                    }
                } else {
                    analysisContent.innerHTML += `
                        <div class="alert alert-danger">
                            <p>没有可用的CSV数据用于提取受理号。</p>
                            <p>请先上传CSV文件。</p>
                        </div>
                    `;
                    
                    // 尝试显示模态框
                    try {
                        const modal = new bootstrap.Modal(modalElement);
                        modal.show();
                    } catch (modalError) {
                        console.error("显示模态框失败:", modalError);
                    }
                }
            });
    } catch (error) {
        console.error("显示受理号模态框失败:", error);
        showError("显示错误", "无法显示受理号核对模态框: " + error.message);
    }
}

/**
 * 判断值是否为3年签证格式
 * @param {string} value 需要检查的值
 * @returns {boolean} 是否为3年签证格式
 */
function isVisa3MFormat(value) {
    if (!value) return false;
    
    // 转换为字符串并去除空白
    const str = String(value).trim().toLowerCase();
    
    // 检查常见的3M签证类型标记
    return str === '3m' || 
           str === '3 m' || 
           str === '3个月' || 
           str === '3 months' || 
           str === '3months' || 
           str === 'three months' || 
           str === '90天' || 
           str === '90 days' || 
           str === '90days' ||
           str === 'c' ||
           str === 'c类' ||
           str === 'c 类' ||
           str === 'category c' ||
           str === 'short stay' ||
           str === '03y' ||  // 添加示例CSV中的值
           str.includes('3m');  // 更宽松的匹配
}

/**
 * 判断值是否为5年签证格式
 * @param {string} value 需要检查的值
 * @returns {boolean} 是否为5年签证格式
 */
function isVisa5MFormat(value) {
    if (!value) return false;
    
    // 转换为字符串并去除空白
    const str = String(value).trim().toLowerCase();
    
    // 检查常见的5M签证类型标记
    return str === '5m' || 
           str === '5 m' || 
           str === '5年' || 
           str === '5 years' || 
           str === '5years' || 
           str === 'five years' || 
           str === 'multiple' || 
           str === 'multiple entry' ||
           str === 'd' ||
           str === 'd类' ||
           str === 'd 类' ||
           str === 'category d' ||
           str === 'long stay' ||
           str === '05y' ||  // 添加示例CSV中的值
           str.includes('5m');  // 更宽松的匹配
}

/**
 * 更新签证类型统计信息
 * @param {number} visa3MCount 3个月签证数量
 * @param {number} visa5MCount 5年签证数量
 * @param {number} visaOtherCount 其他签证数量
 */
function updateVisaTypeStatistics(visa3MCount, visa5MCount, visaOtherCount) {
    try {
        console.log(`更新签证类型统计: 3M=${visa3MCount}, 5M=${visa5MCount}, 其他=${visaOtherCount}`);
        
        // 更新计数
        const visa3MElement = document.getElementById('visa3MCount');
        const visa5MElement = document.getElementById('visa5MCount');
        const otherVisaElement = document.getElementById('visaOtherCount');
        const totalElement = document.getElementById('visaTypeTotal');
        
        if (visa3MElement) {
            visa3MElement.textContent = visa3MCount;
        } else {
            console.error("找不到3个月签证计数元素");
        }
        
        if (visa5MElement) {
            visa5MElement.textContent = visa5MCount;
        } else {
            console.error("找不到5年签证计数元素");
        }
        
        if (otherVisaElement) {
            otherVisaElement.textContent = visaOtherCount;
        } else {
            console.error("找不到其他签证计数元素");
        }
        
        // 计算总数和百分比
        const total = visa3MCount + visa5MCount + visaOtherCount;
        
        // 更新总数
        if (totalElement) {
            totalElement.textContent = `共${total}份`;
        } else {
            console.error("找不到签证类型总数元素");
        }
        
        // 更新进度条
        const visa3MProgressBar = document.getElementById('visa3MProgress');
        const visa5MProgressBar = document.getElementById('visa5MProgress');
        const otherVisaProgressBar = document.getElementById('visaOtherProgress');
        
        if (visa3MProgressBar) {
            const percent3M = total > 0 ? (visa3MCount / total) * 100 : 0;
            visa3MProgressBar.style.width = `${percent3M}%`;
            visa3MProgressBar.setAttribute('aria-valuenow', percent3M);
            visa3MProgressBar.textContent = `${Math.round(percent3M)}%`;
        } else {
            console.error("找不到3个月签证进度条元素");
        }
        
        if (visa5MProgressBar) {
            const percent5M = total > 0 ? (visa5MCount / total) * 100 : 0;
            visa5MProgressBar.style.width = `${percent5M}%`;
            visa5MProgressBar.setAttribute('aria-valuenow', percent5M);
            visa5MProgressBar.textContent = `${Math.round(percent5M)}%`;
        } else {
            console.error("找不到5年签证进度条元素");
        }
        
        if (otherVisaProgressBar) {
            const percentOther = total > 0 ? (visaOtherCount / total) * 100 : 0;
            otherVisaProgressBar.style.width = `${percentOther}%`;
            otherVisaProgressBar.setAttribute('aria-valuenow', percentOther);
            otherVisaProgressBar.textContent = `${Math.round(percentOther)}%`;
        } else {
            console.error("找不到其他签证进度条元素");
        }
    } catch (e) {
        console.error("更新签证类型统计时发生错误:", e);
    }
}

/**
 * 分析CSV数据中的签证类型分布并更新统计信息
 */
function analyzeVisaTypeDistribution(csvData) {
    try {
        if (!csvData || !Array.isArray(csvData) || csvData.length === 0) {
            console.error("CSV数据无效或为空");
            return;
        }
        
        console.log(`分析签证类型分布，共${csvData.length}条记录`);
        
        // 检查前5条记录的visa_type字段
        console.log("检查前5条记录的visa_type字段:");
        for (let i = 0; i < Math.min(5, csvData.length); i++) {
            console.log(`记录${i}: visa_type = ${csvData[i].visa_type || '(未设置)'}`);
        }
        
        // 统计签证类型分布
        let visa3MCount = 0;
        let visa5MCount = 0;
        let otherCount = 0;
        let emptyCount = 0;
        let valueDistribution = {};
        
        // 检查每条记录
        csvData.forEach((record, index) => {
            // 获取签证类型值
            const visaValue = record.visa_type;
            
            // 记录值分布
            if (visaValue === undefined || visaValue === null || visaValue === '') {
                emptyCount++;
                if (index < 10) console.log(`记录 ${index} 的签证类型为空`);
            } else {
                const normalizedValue = String(visaValue).trim().toLowerCase();
                valueDistribution[normalizedValue] = (valueDistribution[normalizedValue] || 0) + 1;
                
                // 分类签证类型
                if (isVisa3MFormat(normalizedValue)) {
                    visa3MCount++;
                    if (index < 10) console.log(`记录 ${index} 的签证类型: ${visaValue} 识别为3M`);
                } else if (isVisa5MFormat(normalizedValue)) {
                    visa5MCount++;
                    if (index < 10) console.log(`记录 ${index} 的签证类型: ${visaValue} 识别为5M`);
                } else {
                    otherCount++;
                    if (index < 10) console.log(`记录 ${index} 的签证类型: ${visaValue} 识别为其他`);
                }
            }
        });
        
        // 输出值分布
        console.log("签证类型值分布:", valueDistribution);
        console.log(`签证类型统计: 3个月: ${visa3MCount}, 5年: ${visa5MCount}, 其他: ${otherCount}, 空值: ${emptyCount}`);
        
        // 检查HTML元素是否存在
        console.log("检查HTML元素:");
        console.log("visa3MCount元素存在:", !!document.getElementById('visa3MCount'));
        console.log("visa5MCount元素存在:", !!document.getElementById('visa5MCount'));
        console.log("visaOtherCount元素存在:", !!document.getElementById('visaOtherCount'));
        console.log("visaTypeTotal元素存在:", !!document.getElementById('visaTypeTotal'));
        
        // 更新UI
        if (typeof updateVisaTypeStatistics === 'function') {
            console.log("调用updateVisaTypeStatistics函数更新UI...");
            updateVisaTypeStatistics(visa3MCount, visa5MCount, otherCount);
        } else {
            console.error("updateVisaTypeStatistics函数未定义");
        }
    } catch (e) {
        console.error("分析签证类型分布时发生错误:", e);
    }
}

// 处理受理号数据的函数
function processAcceptanceData(acceptanceData) {
    try {
        console.log("处理受理号数据...", acceptanceData.length);
        
        // 增强受理号数据，添加从CSV数据中获取的额外信息
        if (currentCsvData && currentCsvData.length > 0) {
            acceptanceData.forEach((item, index) => {
                // 尝试通过受理号或护照号匹配CSV记录
                const matchedRecord = currentCsvData.find(record => 
                    (record.acceptance_number && item.acceptance_number && 
                     record.acceptance_number.trim() === item.acceptance_number.trim()) ||
                    (record.passport_number && item.passport_number && 
                     record.passport_number.trim() === item.passport_number.trim())
                );
                
                // 如果找到匹配记录，复制重要字段
                if (matchedRecord) {
                    // 复制签证类型
                    item.visa_type = matchedRecord.visa_type || item.visa_type;
                    // 复制姓名信息(如果缺失)
                    if (!item.surname && matchedRecord.surname) item.surname = matchedRecord.surname;
                    if (!item.given_name && matchedRecord.given_name) item.given_name = matchedRecord.given_name;
                    // 复制团队受理号(如果缺失)
                    if (!item.team_acceptance_number && matchedRecord.team_acceptance_number) {
                        item.team_acceptance_number = matchedRecord.team_acceptance_number;
                    }
                }
            });
        }
        
        // 保存处理后的受理号数据到全局变量，供表格渲染使用
        processedAcceptanceData = acceptanceData;
        
        // 重置高亮受理号数组
        highlightedAcceptanceNumbers = [];
        
        // 确保模态框元素仍然存在
        const modalElement = document.getElementById('acceptanceNumberModal');
        const analysisContent = document.getElementById('analysisContent');
        const tableBody = document.getElementById('acceptanceNumberTableBody');
        
        if (!modalElement || !analysisContent || !tableBody) {
            throw new Error("模态框元素或必要容器不存在");
        }
        
        // 分析受理号
        const analysisResult = analyzeAcceptanceNumbers(acceptanceData);
        console.log('受理号分析结果:', analysisResult);
        const emptyItems = analysisResult.emptyItems;
        const discontinuities = analysisResult.discontinuities;
        
        // 详细输出不连续点信息
        if (discontinuities.length > 0) {
            console.log('发现不连续点数量:', discontinuities.length);
            discontinuities.forEach((disc, index) => {
                console.log(`不连续点 ${index + 1}:`, disc);
                console.log(`  - 从 ${disc.from} 到 ${disc.to}, 间隔: ${disc.gap}`);
                console.log(`  - 位置: ${disc.position}, 索引: from=${disc.fromIndex}, to=${disc.toIndex}`);
            });
        } else {
            console.log('未发现不连续点');
        }
        
        // 分析团队受理号
        const teamAnalysisResult = analyzeTeamAcceptanceNumbers();
        console.log('团队受理号分析结果:', teamAnalysisResult);
        
        // 更新团队受理号可视化卡片
        updateTeamAcceptanceCodeVisualizer(teamAnalysisResult);
        
        // 分析签证类型分布 - 只在尚未分析时进行
        try {
            // 检查统计卡片是否已有数据
            const visa3MCountEl = document.getElementById('visa3MCount');
            const hasStats = visa3MCountEl && visa3MCountEl.textContent !== '0';
            
            if (!hasStats && currentCsvData && Array.isArray(currentCsvData) && currentCsvData.length > 0) {
                console.log("执行签证类型分析...");
                // 检查是否已经有visa_type字段
                const firstRecord = currentCsvData[0];
                const hasVisaTypeField = firstRecord && 'visa_type' in firstRecord;
                
                if (hasVisaTypeField) {
                    analyzeVisaTypeDistribution(currentCsvData);
                } else {
                    console.log("当前CSV数据缺少visa_type字段，无法分析签证类型");
                }
            } else if (hasStats) {
                console.log("已有签证类型统计数据，跳过分析");
            } else {
                console.log("没有可用的CSV数据进行签证类型分析");
            }
        } catch (e) {
            console.error("签证类型分析错误:", e);
            // 继续执行，不影响主流程
        }
        
        // 创建表格内容
        let allRows = [];
        let highlightedRows = [];
        
        // 处理每一条记录
        acceptanceData.forEach((item, index) => {
            // 创建表格行
            const row = document.createElement('tr');
            row.setAttribute('data-index', index);
            
            // 从CSV数据中查找匹配的记录以获取姓名和签证类型
            let nameDisplay = '(空)';
            let teamAcceptanceNumber = item.team_acceptance_number || '(空)';
            let visaType = '(未知)';
            let visaTypeClass = '';
            
            if (currentCsvData && currentCsvData.length > 0) {
                // 尝试通过受理号匹配
                const matchedRecord = currentCsvData.find(record => 
                    record.acceptance_number && 
                    item.acceptance_number && 
                    record.acceptance_number.trim() === item.acceptance_number.trim()
                );
                
                // 如果通过受理号没找到，尝试通过护照号匹配
                const matchedByPassport = !matchedRecord ? 
                    currentCsvData.find(record => 
                        record.passport_number && 
                        item.passport_number && 
                        record.passport_number.trim() === item.passport_number.trim()
                    ) : null;
                
                const recordToUse = matchedRecord || matchedByPassport;
                
                if (recordToUse) {
                    // 优先使用CSV中的姓名数据
                    const surname = recordToUse.surname || '';
                    const givenName = recordToUse.given_name || '';
                    
                    if (surname || givenName) {
                        nameDisplay = surname + ' ' + givenName;
                    }
                    
                    // 获取团队受理号
                    if (recordToUse.team_acceptance_number) {
                        teamAcceptanceNumber = recordToUse.team_acceptance_number;
                    }
                    
                    // 获取签证类型
                    // 优先使用visa_type字段
                    if (recordToUse.visa_type) {
                        const rawValue = recordToUse.visa_type;
                        visaType = String(rawValue).trim();
                        console.log(`使用visa_type字段: ${visaType}`);
                        
                        // 根据签证类型设置样式类
                        if (isVisa3MFormat(visaType)) {
                            visaTypeClass = 'bg-info text-white';
                            visaType = '3M'; // 统一显示格式
                        } else if (isVisa5MFormat(visaType)) {
                            visaTypeClass = 'bg-success text-white';
                            visaType = '5M'; // 统一显示格式
                        }
                    } else {
                        console.log('未找到visa_type字段');
                    }
                } else if (item.surname || item.given_name) {
                    // 如果CSV中没有找到匹配记录，使用API返回的姓名
                    nameDisplay = (item.surname || '') + ' ' + (item.given_name || '');
                }
            } else if (item.surname || item.given_name) {
                // 如果没有CSV数据，使用API返回的姓名
                nameDisplay = (item.surname || '') + ' ' + (item.given_name || '');
            }
            
            nameDisplay = nameDisplay.trim();
            if (nameDisplay === '') nameDisplay = '(空)';
            
            // 保存名字到原始数据，方便后续渲染使用
            item.chinese_name = nameDisplay;
            
            // 检查是否需要高亮显示
            let isHighlighted = false;
            let highlightClass = '';
            let tooltipText = '';
            
            // 检查是否为首尾受理号
            const isFirstOrLast = (index === 0 || index === acceptanceData.length - 1);
            if (isFirstOrLast) {
                isHighlighted = true;
                highlightClass = 'table-warning';
                tooltipText = index === 0 ? '首个受理号' : '最后一个受理号';
            }
            
            // 检查是否为空受理号
            const isEmpty = emptyItems.some(emptyItem => 
                emptyItem.index === index || 
                (item.acceptance_number && emptyItem.acceptance_number === item.acceptance_number)
            );
            
            if (isEmpty) {
                isHighlighted = true;
                highlightClass = 'table-purple'; // 优先使用紫色标记空受理号
                tooltipText = tooltipText ? tooltipText + '，空受理号或格式异常' : '空受理号或格式异常';
            }
            
            // 检查是否存在不连续
            const isDiscontinuous = discontinuities.some(disc => {
                // 直接检查fromIndex和toIndex
                if (disc.fromIndex === index || disc.toIndex === index) {
                    return true;
                }
                
                // 检查位置范围（兼容旧版本）
                if (disc.position) {
                    const positions = disc.position.split('-').map(p => parseInt(p));
                    if (positions.length === 2) {
                        // 检查当前索引是否在不连续点的范围内
                        return index + 1 === positions[0] || index + 1 === positions[1];
                    }
                }
                
                // 检查受理号值（兼容旧版本）
                return item.acceptance_number && 
                       (item.acceptance_number == disc.from || item.acceptance_number == disc.to);
            });
            
            if (isDiscontinuous) {
                isHighlighted = true;
                // 如果已经是首尾或空受理号，保留原来的样式，否则使用蓝色
                highlightClass = (isFirstOrLast || isEmpty) ? highlightClass : 'table-primary';
                tooltipText = tooltipText ? tooltipText + '，不连续受理号' : '不连续受理号';
                console.log('找到不连续受理号:', item.acceptance_number, '索引:', index); // 调试日志
            }
            
            // 检查团队受理号是否异常
            if (teamAnalysisResult.inconsistentItems && 
                teamAnalysisResult.inconsistentItems.some(inconsistentItem => 
                    inconsistentItem.index === index || 
                    (item.team_acceptance_number && inconsistentItem.team_acceptance_number === item.team_acceptance_number)
                )) {
                isHighlighted = true;
                // 使用红色标记团队受理号异常
                highlightClass = 'table-danger';
                tooltipText = tooltipText ? tooltipText + '，团队受理号异常' : '团队受理号异常';
            }
            
            if (isHighlighted) {
                row.className = highlightClass;
                row.setAttribute('data-bs-toggle', 'tooltip');
                row.setAttribute('data-bs-placement', 'top');
                row.setAttribute('title', tooltipText);
                highlightedRows.push(row);
                highlightedAcceptanceNumbers.push(index); // 添加到需要重点核对的索引列表
                
                // 在processedAcceptanceData中也标记此记录需要高亮
                acceptanceData[index].isHighlighted = true;
            }
            
            // 添加到所有行数组
            allRows.push(row);
            
            // 创建标记按钮
            const markBtnHtml = `<button class="btn btn-sm btn-outline-secondary mark-btn py-0" data-index="${index}">标记</button>`;
            
            // 设置行内容
            row.innerHTML = `
                <td class="text-center">${index + 1}</td>
                <td>${item.acceptance_number || '(空)'}</td>
                <td>${nameDisplay}</td>
                <td class="text-center"><span class="badge ${visaTypeClass}">${visaType}</span></td>
                <td>${item.passport_number || '(空)'}</td>
                <td>${teamAcceptanceNumber}</td>
                <td class="text-center p-1">${markBtnHtml}</td>
            `;
            
            // 如果已经标记，更新样式
            if (markedAcceptanceNumbers.has(index)) {
                row.classList.add('marked');
                const markBtn = row.querySelector('.mark-btn');
                if (markBtn) markBtn.textContent = '已标记';
            }
        });
        
        // 构建分析信息内容
        let analysisContentHTML = '';
        
        // 显示团队受理号信息
        if (teamAnalysisResult) {
            if (teamAnalysisResult.hasTeamAcceptanceNumber) {
                analysisContentHTML += '<div class="alert ' + (teamAnalysisResult.isConsistent ? 'alert-success' : 'alert-danger') + '">';
                analysisContentHTML += '<h5>团队受理号信息</h5>';
                
                if (teamAnalysisResult.isConsistent) {
                    analysisContentHTML += '<p class="mb-1 small">所有团队受理号前9位一致: <strong>' + teamAnalysisResult.prefix + '</strong></p>';
                    analysisContentHTML += '<p class="mb-1 small">团队受理号解析:</p>';
                    analysisContentHTML += '<ul class="small">';
                    analysisContentHTML += '<li>旅行社编码: <strong>' + teamAnalysisResult.prefix.substring(0, 3) + '</strong></li>';
                    analysisContentHTML += '<li>送签日期: <strong>' + teamAnalysisResult.prefix.substring(3, 9) + '</strong> (' + 
                        formatTeamAcceptanceDate(teamAnalysisResult.prefix.substring(3, 9)) + ')</li>';
                    analysisContentHTML += '</ul>';
                } else {
                    analysisContentHTML += '<p class="mb-1 small">发现不一致的团队受理号前缀，请检查:</p>';
                    analysisContentHTML += '<ul class="small">';
                    
                    // 显示所有不同的前缀
                    teamAnalysisResult.uniquePrefixes.forEach(prefix => {
                        const count = teamAnalysisResult.prefixCounts[prefix];
                        analysisContentHTML += '<li>前缀: <strong>' + prefix + '</strong> - 出现 ' + count + ' 次</li>';
                    });
                    
                    analysisContentHTML += '</ul>';
                    
                    // 显示不一致的记录
                    if (teamAnalysisResult.inconsistentItems && teamAnalysisResult.inconsistentItems.length > 0) {
                        analysisContentHTML += '<p class="mb-1 small">不一致的记录:</p>';
                        analysisContentHTML += '<ul class="small">';
                        
                        teamAnalysisResult.inconsistentItems.slice(0, 10).forEach(item => {
                            analysisContentHTML += '<li>位置 ' + (item.index + 1) + ': ' + 
                                '团队受理号 "' + item.team_acceptance_number + '" - ' + 
                                '个人受理号 "' + (item.acceptance_number || '(空)') + '"</li>';
                        });
                        
                        if (teamAnalysisResult.inconsistentItems.length > 10) {
                            analysisContentHTML += '<li>... 还有 ' + (teamAnalysisResult.inconsistentItems.length - 10) + ' 条记录</li>';
                        }
                        
                        analysisContentHTML += '</ul>';
                    }
                }
                
                analysisContentHTML += '</div>';
            } else {
                analysisContentHTML += '<div class="alert alert-warning">';
                analysisContentHTML += '<h5>团队受理号信息</h5>';
                analysisContentHTML += '<p class="small">未找到团队受理号数据。团队受理号应位于CSV文件的第15列。</p>';
                analysisContentHTML += '</div>';
            }
        }
        
        // 显示首尾受理号信息
        if (acceptanceData.length > 0) {
            const firstItem = acceptanceData[0];
            const lastItem = acceptanceData[acceptanceData.length - 1];
            
            analysisContentHTML += '<div class="alert alert-warning">';
            analysisContentHTML += '<h5>首尾受理号信息</h5>';
            analysisContentHTML += '<ul class="small">';
            
            // 显示第一个受理号
            analysisContentHTML += '<li>首个受理号: <strong>' + 
                (firstItem.acceptance_number || '(空)') + 
                '</strong> - 位置: 1</li>';
            
            // 显示最后一个受理号
            if (acceptanceData.length > 1) {
                analysisContentHTML += '<li>最后受理号: <strong>' + 
                    (lastItem.acceptance_number || '(空)') + 
                    '</strong> - 位置: ' + acceptanceData.length + '</li>';
            }
            
            analysisContentHTML += '</ul>';
            analysisContentHTML += '<p class="small mb-0">请确认首尾受理号与实际材料一致。</p>';
            analysisContentHTML += '</div>';
        }
        
        // 显示空受理号信息
        if (emptyItems.length > 0) {
            analysisContentHTML += '<div class="alert alert-danger">';
            analysisContentHTML += '<h5>空受理号或格式异常受理号 (' + emptyItems.length + ')</h5>';
            analysisContentHTML += '<ul class="small">';
            emptyItems.forEach(item => {
                // 获取位置信息
                const positionDisplay = typeof item.position === 'number' ? 
                    item.position : (item.index + 1);
                
                analysisContentHTML += '<li>位置 <strong>' + positionDisplay + '</strong>: ' + 
                    (item.value ? `非数字受理号 "${item.value}"` : '空受理号') + 
                    (item.passport_number ? ` - 护照号: ${item.passport_number}` : '') + '</li>';
            });
            analysisContentHTML += '</ul></div>';
        }
        
        // 显示不连续受理号信息
        if (discontinuities.length > 0) {
            analysisContentHTML += '<div class="alert alert-primary">';
            analysisContentHTML += '<h5>不连续受理号 (' + discontinuities.length + ')</h5>';
            analysisContentHTML += '<ul class="small">';
            discontinuities.forEach(item => {
                analysisContentHTML += '<li>位置 <strong>' + item.position + '</strong>: ' + 
                    '从 "' + item.from + '" 跳到 "' + item.to + '" ' + 
                    ' <small class="text-muted">(跳跃了 ' + (item.gap - 1) + ' 个数)</small></li>';
            });
            analysisContentHTML += '</ul>';
            analysisContentHTML += '<p class="small mb-0"><strong>注意:</strong> 不连续受理号的前后记录都已标记为蓝色，请重点检查。</p>';
            analysisContentHTML += '</div>';
        }
        
        // 如果没有问题，显示成功消息
        if (emptyItems.length === 0 && discontinuities.length === 0 && 
            (teamAnalysisResult && (teamAnalysisResult.isConsistent || !teamAnalysisResult.hasTeamAcceptanceNumber))) {
            // 添加成功提示
            analysisContentHTML += '<div class="alert alert-success">';
            if (teamAnalysisResult && teamAnalysisResult.hasTeamAcceptanceNumber) {
                analysisContentHTML += '<p class="small mb-0">所有受理号格式正确且连续，团队受理号前缀一致。</p>';
            } else {
                analysisContentHTML += '<p class="small mb-0">所有受理号格式正确且连续。</p>';
            }
            analysisContentHTML += '</div>';
        }
        
        // 更新模态框内容
        analysisContent.innerHTML = analysisContentHTML;
        
        // 定义渲染表格的函数
        function renderAcceptanceNumberTable(mode) {
            try {
                tableBody.innerHTML = '';
                
                let rowsToShow = mode === 'all' ? allRows : highlightedRows;
                
                rowsToShow.forEach(row => {
                    tableBody.appendChild(row);
                });
                
                // 更新计数器
                const counter = document.getElementById('acceptanceNumberCounter');
                if (counter) {
                    counter.textContent = `显示: ${rowsToShow.length}/${allRows.length}`;
                } else {
                    console.log("找不到计数器元素，跳过更新");
                }
                
                // 更新标记进度
                updateMarkProgress();
            } catch (e) {
                console.error("渲染表格时发生错误:", e);
                showErrorMessage("渲染表格时发生错误: " + e.message);
            }
        }
        
        // 初始渲染表格（默认仅显示高亮行）
        renderAcceptanceNumberTable('highlighted');
        
        // 添加标记按钮的事件委托
        if (tableBody) {
            // 移除旧的事件监听器（如果存在）
            tableBody.removeEventListener('click', tableBodyClickHandler);
            // 添加新的事件监听器
            tableBody.addEventListener('click', tableBodyClickHandler);
        }
        
        // 初始化工具提示
        try {
            const tooltipTriggerList = [].slice.call(document.querySelectorAll('[data-bs-toggle="tooltip"]'));
            tooltipTriggerList.forEach(function (tooltipTriggerEl) {
                new bootstrap.Tooltip(tooltipTriggerEl);
            });
        } catch (e) {
            console.error("初始化工具提示失败:", e);
            // 继续执行，不影响主流程
        }
        
        // 显示模态框
        try {
            const modal = new bootstrap.Modal(modalElement);
            modal.show();
        } catch (e) {
            console.error("显示模态框失败:", e);
            showError("显示错误", "无法显示受理号核对模态框: " + e.message);
        }
        
        // 保存渲染函数到全局变量，供显示模式切换按钮使用
        window.currentRenderFunction = renderAcceptanceNumberTable;
        
        // 返回渲染函数供外部使用
        return renderAcceptanceNumberTable;
    } catch (error) {
        console.error("处理受理号数据时发生错误:", error);
        showError("处理错误", "处理受理号数据时发生错误: " + error.message);
        return null;
    }
}

// 表格点击事件处理
function tableBodyClickHandler(e) {
    if (e.target.classList.contains('mark-btn')) {
        const index = parseInt(e.target.getAttribute('data-index'));
        toggleMarkAcceptanceNumber(index);
    }
}

// 从CSV数据中提取备用受理号数据
function extractBackupAcceptanceData() {
    try {
        if (!currentCsvData || !Array.isArray(currentCsvData) || currentCsvData.length === 0) {
            console.error("没有可用的CSV数据进行备份提取");
            return [];
        }
        
        console.log("开始从CSV数据中提取备份受理号数据");
        const backupData = [];
        
        currentCsvData.forEach((record, i) => {
            // 确保受理号和护照号存在，避免null值
            // 重要：受理号使用索引字段，与后端API保持一致
            const acceptanceNumber = record.index || '';
            const passportNumber = record.passport_number || '';
            
            // 创建一个包含必要字段的对象
            const item = {
                acceptance_number: acceptanceNumber.toString().trim(),
                passport_number: passportNumber.trim(),
                team_acceptance_number: record.team_acceptance_number || '',
                surname: record.surname || '',
                given_name: record.given_name || '',
                // 可选填充其他可能有用的字段
                name: record.name || '',
                pinyin_name: record.pinyin_name || '',
                english_name: record.english_name || '',
                // 保留原始索引，便于后续定位
                original_index: i
            };
            
            console.log(`索引 ${i} 的受理号数据:`, {
                index: record.index,
                acceptanceNumber: acceptanceNumber,
                passportNumber: passportNumber
            });
            
            backupData.push(item);
        });
        
        console.log(`从CSV数据中提取了 ${backupData.length} 条备份受理号数据`);
        return backupData;
    } catch (error) {
        console.error("提取备份受理号数据时出错:", error);
        throw new Error("无法从CSV数据中提取备份受理号数据: " + error.message);
    }
}

// 切换受理号标记状态
function toggleMarkAcceptanceNumber(index) {
    try {
        console.log(`切换标记状态: ${index}`);
        
        // 获取表格中的行
        const row = document.querySelector(`#acceptanceNumberTableBody tr[data-index="${index}"]`);
        if (!row) {
            console.error(`找不到索引为 ${index} 的行`);
            return;
        }
        
        // 存储行的原始类名，用于稍后还原
        if (!row.hasAttribute('data-original-class') && !markedAcceptanceNumbers.has(index)) {
            // 保存背景色类
            const originalClasses = [];
            ['table-primary', 'table-warning', 'table-danger', 'table-purple'].forEach(cls => {
                if (row.classList.contains(cls)) {
                    originalClasses.push(cls);
                }
            });
            row.setAttribute('data-original-class', originalClasses.join(' '));
        }
        
        const originalClass = row.getAttribute('data-original-class') || '';
        const markBtn = row.querySelector('.mark-btn');
        
        // 切换标记状态
        if (markedAcceptanceNumbers.has(index)) {
            // 取消标记
            markedAcceptanceNumbers.delete(index);
            
            // 恢复行样式
            row.classList.remove('table-success');
            if (originalClass) {
                originalClass.split(' ').forEach(cls => {
                    if (cls) row.classList.add(cls);
                });
            }
            
            // 更新按钮
            if (markBtn) {
                markBtn.textContent = '标记';
                markBtn.classList.remove('btn-success');
                markBtn.classList.add('btn-outline-secondary');
            }
            
            console.log(`取消标记: ${index}, 当前标记数: ${markedAcceptanceNumbers.size}`);
        } else {
            // 添加标记
            markedAcceptanceNumbers.add(index);
            
            // 更新行样式
            ['table-primary', 'table-warning', 'table-danger', 'table-purple'].forEach(cls => {
                row.classList.remove(cls);
            });
            row.classList.add('table-success');
            
            // 更新按钮
            if (markBtn) {
                markBtn.textContent = '已标记';
                markBtn.classList.remove('btn-outline-secondary');
                markBtn.classList.add('btn-success');
            }
            
            console.log(`添加标记: ${index}, 当前标记数: ${markedAcceptanceNumbers.size}`);
        }
        
        // 更新标记进度
        updateMarkingProgress();
    } catch (error) {
        console.error("切换标记状态时出错:", error);
    }
}

// 更新标记进度
function updateMarkProgress() {
    try {
        // 获取需要标记的总数（高亮行数量）
        const total = highlightedAcceptanceNumbers.length;
        
        // 计算已标记的高亮行数量
        let marked = 0;
        highlightedAcceptanceNumbers.forEach(index => {
            if (markedAcceptanceNumbers.has(index)) marked++;
        });
        
        // 更新进度条
        const progressBar = document.getElementById('markProgressBar');
        if (progressBar) {
            const percentage = total > 0 ? Math.round((marked / total) * 100) : 0;
            progressBar.style.width = `${percentage}%`;
            progressBar.setAttribute('aria-valuenow', percentage);
            
            // 根据进度更新颜色
            if (percentage === 100) {
                progressBar.classList.remove('bg-warning', 'bg-info');
                progressBar.classList.add('bg-success');
            } else if (percentage > 50) {
                progressBar.classList.remove('bg-warning', 'bg-success');
                progressBar.classList.add('bg-info');
            } else {
                progressBar.classList.remove('bg-info', 'bg-success');
                progressBar.classList.add('bg-warning');
            }
        } else {
            console.log("未找到进度条元素，跳过更新");
        }
        
        // 更新计数文本
        const counter = document.getElementById('markCounter');
        if (counter) {
            counter.textContent = `标记进度: ${marked}/${total}`;
        } else {
            console.log("未找到计数器元素，跳过更新");
        }
        
        // 检查是否所有高亮行都已标记
        const allMarked = total > 0 && marked === total;
        
        // 更新完成状态
        const markComplete = document.getElementById('markComplete');
        if (markComplete) {
            if (allMarked) {
                markComplete.style.display = 'inline-block';
            } else {
                markComplete.style.display = 'none';
            }
        }
    } catch (error) {
        console.error("更新标记进度时出错:", error);
    }
}

// 重置签证类型统计
function resetVisaTypeStatistics() {
    try {
        // 重置签证类型计数
        const visa3MCount = document.getElementById('visa3MCount');
        const visa5MCount = document.getElementById('visa5MCount');
        const visaOtherCount = document.getElementById('visaOtherCount');
        const visaTotalCount = document.getElementById('visaTotalCount');
        
        if (visa3MCount) visa3MCount.textContent = '0';
        if (visa5MCount) visa5MCount.textContent = '0';
        if (visaOtherCount) visaOtherCount.textContent = '0';
        if (visaTotalCount) visaTotalCount.textContent = '0';
        
        // 重置进度条
        const visa3MProgress = document.getElementById('visa3MProgress');
        const visa5MProgress = document.getElementById('visa5MProgress');
        const visaOtherProgress = document.getElementById('visaOtherProgress');
        
        if (visa3MProgress) {
            visa3MProgress.style.width = '0%';
            visa3MProgress.setAttribute('aria-valuenow', 0);
        }
        
        if (visa5MProgress) {
            visa5MProgress.style.width = '0%';
            visa5MProgress.setAttribute('aria-valuenow', 0);
        }
        
        if (visaOtherProgress) {
            visaOtherProgress.style.width = '0%';
            visaOtherProgress.setAttribute('aria-valuenow', 0);
        }
        
        console.log("签证类型统计已重置");
    } catch (error) {
        console.error("重置签证类型统计时出错:", error);
    }
}

// 标记全部受理号
function markAllAcceptanceNumbers() {
    const table = document.getElementById('acceptanceNumberTable');
    if (!table) return;
    
    const rows = table.getElementsByTagName('tr');
    for (let i = 1; i < rows.length; i++) { // 从1开始跳过表头
        const row = rows[i];
        if (!row.classList.contains('d-none')) { // 只标记可见行
            // 查找标记按钮
            const markBtn = row.querySelector('.mark-btn');
            if (markBtn) {
                const index = parseInt(markBtn.getAttribute('data-index'));
                if (!isNaN(index)) {
                    // 保存原始类名，用于稍后还原
                    if (!row.getAttribute('data-original-class')) {
                        // 如果是高亮行，保存这些类名
                        const classesToSave = [];
                        if (row.classList.contains('table-primary')) classesToSave.push('table-primary');
                        if (row.classList.contains('table-warning')) classesToSave.push('table-warning');
                        if (row.classList.contains('table-danger')) classesToSave.push('table-danger');
                        if (row.classList.contains('table-purple')) classesToSave.push('table-purple');
                        
                        row.setAttribute('data-original-class', classesToSave.join(' '));
                    }
                    
                    // 添加到标记集合
                    markedAcceptanceNumbers.add(index);
                    
                    // 更新按钮文本和样式
                    markBtn.textContent = '已标记';
                    markBtn.classList.remove('btn-outline-secondary');
                    markBtn.classList.add('btn-success');
                    
                    // 移除任何其他颜色类
                    row.classList.remove('table-primary', 'table-warning', 'table-danger', 'table-purple');
                    // 给行添加绿色高亮样式
                    row.classList.add('table-success');
                }
            }
        }
    }
    
    // 更新进度显示
    updateMarkingProgress();
}

// 清除所有标记
function clearAllMarks() {
    const table = document.getElementById('acceptanceNumberTable');
    if (!table) return;
    
    const rows = table.getElementsByTagName('tr');
    for (let i = 1; i < rows.length; i++) {
        const row = rows[i];
        
        // 查找标记按钮
        const markBtn = row.querySelector('.mark-btn');
        if (markBtn) {
            const index = parseInt(markBtn.getAttribute('data-index'));
            if (!isNaN(index)) {
                // 更新按钮文本和样式
                markBtn.textContent = '标记';
                markBtn.classList.remove('btn-success');
                markBtn.classList.add('btn-outline-secondary');
                
                // 移除绿色高亮样式
                row.classList.remove('table-success');
                
                // 恢复原始颜色类
                const originalClass = row.getAttribute('data-original-class') || '';
                if (originalClass) {
                    originalClass.split(' ').forEach(cls => {
                        if (cls) row.classList.add(cls);
                    });
                }
                
                // 清除原始类属性
                row.removeAttribute('data-original-class');
            }
        }
    }
    
    // 清空标记集合
    markedAcceptanceNumbers.clear();
    
    // 更新进度显示
    updateMarkingProgress();
}

// 更新标记进度显示
function updateMarkingProgress() {
    try {
        console.log('更新标记进度...');
        
        // 获取进度显示元素
        const progressElement = document.getElementById('markingProgress');
        const totalElement = document.getElementById('totalRecords');
        const markProgress = document.getElementById('markProgress');
        const progressBar = document.getElementById('markingProgressBar');
        const headerProgressBar = document.getElementById('markProgressBar');
        const markCounter = document.getElementById('markCounter');
        const markComplete = document.getElementById('markComplete');
        
        // 获取当前表格显示的行数
        const visibleRows = document.querySelectorAll('#acceptanceNumberTableBody tr').length;
        console.log('显示行数:', visibleRows);
        
        // 获取已标记的行数
        const markedCount = markedAcceptanceNumbers.size;
        console.log('已标记数:', markedCount);
        
        // 获取高亮行数
        const highlightedCount = highlightedAcceptanceNumbers.length;
        console.log('高亮行数:', highlightedCount);
        
        // 计算已标记的高亮行数
        const markedHighlightedCount = Array.from(markedAcceptanceNumbers)
            .filter(idx => highlightedAcceptanceNumbers.includes(idx)).length;
        console.log('已标记的高亮行数:', markedHighlightedCount);
        
        // 计算百分比
        const percentage = Math.round(
            visibleRows > 0 ? (markedCount / visibleRows) * 100 : 0
        );
        console.log('进度百分比:', percentage);
        
        // 更新进度文本
        if (progressElement && totalElement) {
            progressElement.textContent = String(markedCount);
            totalElement.textContent = String(visibleRows);
        }
        
        if (markProgress) {
            markProgress.textContent = `已标记: ${markedCount}/${visibleRows}`;
        }
        
        if (markCounter) {
            markCounter.textContent = `标记进度: ${markedCount}/${visibleRows}`;
        }
        
        // 更新进度条
        if (progressBar) {
            progressBar.style.width = `${percentage}%`;
            progressBar.setAttribute('aria-valuenow', percentage);
            
            // 根据进度设置颜色
            if (percentage === 100) {
                progressBar.classList.remove('bg-warning', 'bg-info');
                progressBar.classList.add('bg-success');
            } else if (percentage > 50) {
                progressBar.classList.remove('bg-warning', 'bg-success');
                progressBar.classList.add('bg-info');
            } else {
                progressBar.classList.remove('bg-info', 'bg-success');
                progressBar.classList.add('bg-warning');
            }
        }
        
        // 同步更新页头进度条
        if (headerProgressBar) {
            headerProgressBar.style.width = `${percentage}%`;
            headerProgressBar.setAttribute('aria-valuenow', percentage);
            
            if (percentage === 100) {
                headerProgressBar.classList.remove('bg-warning', 'bg-info');
                headerProgressBar.classList.add('bg-success');
            } else if (percentage > 50) {
                headerProgressBar.classList.remove('bg-warning', 'bg-success');
                headerProgressBar.classList.add('bg-info');
            } else {
                headerProgressBar.classList.remove('bg-info', 'bg-success');
                headerProgressBar.classList.add('bg-warning');
            }
        }
        
        // 更新完成标记显示
        if (markComplete) {
            const allHighlightedMarked = 
                highlightedCount > 0 && markedHighlightedCount === highlightedCount;
                
            markComplete.style.display = allHighlightedMarked ? 'inline-block' : 'none';
        }
        
    } catch (error) {
        console.error('更新标记进度时出错:', error);
    }
}

// 渲染受理号表格
function renderAcceptanceNumberTable(mode = 'all') {
    console.log('渲染受理号表格, 模式:', mode);
    
    const table = document.getElementById('acceptanceNumberTable');
    if (!table || !processedAcceptanceData || processedAcceptanceData.length === 0) {
        console.error('找不到表格元素或受理号数据不可用');
        return;
    }
    
    const tbody = document.getElementById('acceptanceNumberTableBody');
    if (!tbody) {
        console.error('找不到表格体元素');
        return;
    }
    
    tbody.innerHTML = ''; // 清空现有内容
    
    // 更新按钮状态
    const showAllBtn = document.getElementById('showAllRows');
    const showHighlightedBtn = document.getElementById('showHighlightedRows');
    
    if (showAllBtn && showHighlightedBtn) {
        if (mode === 'all') {
            showAllBtn.classList.add('btn-primary');
            showAllBtn.classList.remove('btn-outline-primary');
            showHighlightedBtn.classList.remove('btn-primary');
            showHighlightedBtn.classList.add('btn-outline-primary');
        } else if (mode === 'highlighted') {
            showHighlightedBtn.classList.add('btn-primary');
            showHighlightedBtn.classList.remove('btn-outline-primary');
            showAllBtn.classList.remove('btn-primary');
            showAllBtn.classList.add('btn-outline-primary');
        }
    }
    
    // 计数器
    let totalRows = processedAcceptanceData.length;
    let displayedRows = 0;
    
    processedAcceptanceData.forEach((record, index) => {
        const shouldShow = mode === 'all' || 
                          (mode === 'highlighted' && highlightedAcceptanceNumbers.includes(index));
        
        if (shouldShow) {
            displayedRows++;
            
            // 创建新行
            const row = document.createElement('tr');
            row.setAttribute('data-index', index);
            
            // 检查是否已标记
            const isMarked = markedAcceptanceNumbers.has(index);
            
            // 确定行的颜色类
            let rowColorClass = '';
            if (isMarked) {
                rowColorClass = 'table-success';
            } else {
                // 根据记录的position属性决定高亮颜色
                if (highlightedAcceptanceNumbers.includes(index)) {
                    if (index === 0 || index === processedAcceptanceData.length - 1) {
                        // 首尾记录使用黄色
                        rowColorClass = 'table-warning';
                    } else if (record.position === 'empty' || record.position === 'invalid_format') {
                        // 空记录或格式异常使用紫色
                        rowColorClass = 'table-purple';
                    } else if (record.position === 'discontinuity_before' || record.position === 'discontinuity_after') {
                        // 不连续记录使用蓝色
                        rowColorClass = 'table-primary';
                    } else {
                        // 其他高亮记录使用蓝色
                        rowColorClass = 'table-primary';
                    }
                }
            }
            
            // 应用颜色类
            if (rowColorClass) {
                row.classList.add(rowColorClass);
            }
            
            // 获取或初始化相关字段
            const acceptanceNumber = record.acceptance_number || '(空)';
            let chineseName = record.chinese_name || '(空)';
            const passportNumber = record.passport_number || '(空)';
            const teamAcceptanceNumber = record.team_acceptance_number || '(空)';
            
            // 尝试组合姓名
            if (chineseName === '(空)' && (record.surname || record.given_name)) {
                chineseName = `${record.surname || ''} ${record.given_name || ''}`.trim();
                if (!chineseName) chineseName = '(空)';
            }
            
            // 获取签证类型
            let visaType = record.visa_type || '未知';
            let visaTypeClass = '';
            
            if (isVisa3MFormat(visaType)) {
                visaTypeClass = 'bg-info text-white';
                visaType = '3M';
            } else if (isVisa5MFormat(visaType)) {
                visaTypeClass = 'bg-success text-white';
                visaType = '5M';
            } else {
                visaTypeClass = 'bg-secondary text-white';
            }
            
            // 创建标记按钮
            const markBtnText = isMarked ? '已标记' : '标记';
            const markBtnClass = isMarked ? 'btn-success' : 'btn-outline-secondary';
            
            // 设置行内容
            row.innerHTML = `
                <td class="text-center">${index + 1}</td>
                <td>${acceptanceNumber}</td>
                <td>${chineseName}</td>
                <td class="text-center"><span class="badge ${visaTypeClass}">${visaType}</span></td>
                <td>${passportNumber}</td>
                <td>${teamAcceptanceNumber}</td>
                <td class="text-center p-1">
                    <button class="btn btn-sm ${markBtnClass} mark-btn py-0" data-index="${index}">${markBtnText}</button>
                </td>
            `;
            
            tbody.appendChild(row);
        }
    });
    
    // 使用事件委托添加标记按钮点击事件
    tbody.removeEventListener('click', tableBodyClickHandler);
    tbody.addEventListener('click', tableBodyClickHandler);
    
    // 更新显示计数
    const counter = document.getElementById('acceptanceNumberCounter');
    if (counter) {
        counter.textContent = `显示: ${displayedRows}/${totalRows}`;
    }
    
    // 更新标记进度
    updateMarkingProgress();
    
    // 保存当前渲染函数以供后续使用
    window.currentRenderFunction = function(newMode) {
        renderAcceptanceNumberTable(newMode);
    };
    
    console.log(`表格渲染完成, 显示了 ${displayedRows}/${totalRows} 条记录`);
}

// 初始化受理号核对功能
function initAcceptanceNumberChecking() {
    console.log('初始化受理号核对功能...');
    
    // 绑定标记全部按钮事件
    const markAllBtn = document.getElementById('markAllBtn');
    if (markAllBtn) {
        console.log('找到标记全部按钮，绑定事件');
        markAllBtn.addEventListener('click', markAllAcceptanceNumbers);
    } else {
        console.error('未找到标记全部按钮 (id: markAllBtn)');
    }
    
    // 绑定清除标记按钮事件
    const clearMarksBtn = document.getElementById('clearMarksBtn');
    if (clearMarksBtn) {
        console.log('找到清除标记按钮，绑定事件');
        clearMarksBtn.addEventListener('click', clearAllMarks);
    } else {
        console.error('未找到清除标记按钮 (id: clearMarksBtn)');
    }
    
    // 绑定显示模式切换按钮事件
    const showAllBtn = document.getElementById('showAllRows');
    const showHighlightedBtn = document.getElementById('showHighlightedRows');
    const showAllAcceptanceBtn = document.getElementById('showAllAcceptanceNumbers');
    
    console.log('显示按钮状态:', {
        'showAllRows': !!showAllBtn,
        'showHighlightedRows': !!showHighlightedBtn,
        'showAllAcceptanceNumbers': !!showAllAcceptanceBtn
    });
    
    if (showAllBtn) {
        showAllBtn.addEventListener('click', function() {
            console.log('点击了显示所有行按钮');
            renderAcceptanceNumberTable('all');
        });
    }
    
    if (showHighlightedBtn) {
        showHighlightedBtn.addEventListener('click', function() {
            console.log('点击了显示高亮行按钮');
            renderAcceptanceNumberTable('highlighted');
        });
    }
    
    if (showAllAcceptanceBtn) {
        showAllAcceptanceBtn.addEventListener('click', function() {
            console.log('点击了显示全部受理号按钮');
            renderAcceptanceNumberTable('all');
        });
    }
    
    console.log('受理号核对功能初始化完成');
}