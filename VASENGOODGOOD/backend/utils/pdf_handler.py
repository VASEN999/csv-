import fitz  # PyMuPDF
import os
import hashlib
from typing import Optional, List, Dict
import logging
import json
import time
from flask import current_app

logger = logging.getLogger(__name__)

class PDFHandler:
    def __init__(self, file_path: str, cache=None):
        self.file_path = file_path
        self.text_by_page = {}  # 存储每页的文本
        self.file_hash = None
        self.processed_data = None
        self.cache = cache  # 接收外部传入的缓存对象
        
        # 计算文件哈希值 - 使用文件名中的哈希值而不是重新计算
        file_name = os.path.basename(file_path)
        if file_name.endswith('.pdf') and len(file_name) > 4:
            self.file_hash = file_name[:-4]  # 移除.pdf后缀
            logger.info(f"从文件名获取哈希值: {self.file_hash}")
        else:
            # 如果文件名不符合预期格式，重新计算哈希值
            self._calculate_file_hash()
        
        # 检查是否存在预处理数据
        self._load_or_process_pdf()

    def _calculate_file_hash(self) -> None:
        """计算文件的 SHA-256 哈希值"""
        try:
            sha256_hash = hashlib.sha256()
            with open(self.file_path, "rb") as f:
                # 读取前1MB用于计算哈希值，提高性能
                data = f.read(1024 * 1024)
                if data:
                    sha256_hash.update(data)
            self.file_hash = sha256_hash.hexdigest()
            logger.info(f"计算文件哈希值: {self.file_hash}")
        except Exception as e:
            logger.error(f"计算文件哈希值失败: {str(e)}")
            raise

    def _get_cache_key(self) -> str:
        """获取缓存键"""
        return f"pdf_data_{self.file_hash}"

    def _load_or_process_pdf(self) -> None:
        """从缓存加载或处理PDF文件"""
        cache_key = self._get_cache_key()
        
        # 尝试从Flask缓存获取
        cached_data = None
        if self.cache:
            cached_data = self.cache.get(cache_key)
            if cached_data:
                logger.info(f"从Flask缓存加载PDF数据: {cache_key}")
                self.processed_data = cached_data
                self.text_by_page = cached_data.get('text_by_page', {})
                return
        
        # 如果没有Flask缓存，尝试从文件缓存加载
        cache_path = self._get_file_cache_path()
        try:
            if os.path.exists(cache_path):
                file_modify_time = os.path.getmtime(self.file_path)
                cache_modify_time = os.path.getmtime(cache_path)
                
                # 只使用比PDF文件更新的缓存
                if cache_modify_time > file_modify_time:
                    logger.info(f"从文件缓存加载PDF数据: {cache_path}")
                    with open(cache_path, 'r', encoding='utf-8') as f:
                        cached_data = json.load(f)
                        self.processed_data = cached_data
                        self.text_by_page = cached_data.get('text_by_page', {})
                        
                        # 将文件缓存同步到Flask缓存
                        if self.cache:
                            self.cache.set(cache_key, cached_data)
                        return
                else:
                    logger.info(f"文件缓存过期，PDF文件({file_modify_time})比缓存({cache_modify_time})更新")
            else:
                logger.info(f"未找到文件缓存: {cache_path}")
        except Exception as e:
            logger.warning(f"从文件缓存加载失败，将处理PDF: {str(e)}")
            # 尝试删除损坏的缓存
            try:
                if os.path.exists(cache_path):
                    os.remove(cache_path)
                    logger.info(f"已删除损坏的缓存文件: {cache_path}")
            except:
                pass
        
        # 如果没有缓存，处理PDF
        self._process_pdf()
        
        # 保存处理结果到缓存
        if self.processed_data:
            # 保存到Flask缓存
            if self.cache:
                self.cache.set(cache_key, self.processed_data)
                logger.info(f"已保存到Flask缓存: {cache_key}")
            
            # 同时保存到文件缓存作为备份
            try:
                with open(cache_path, 'w', encoding='utf-8') as f:
                    json.dump(self.processed_data, f, ensure_ascii=False)
                logger.info(f"已保存到文件缓存: {cache_path}")
            except Exception as e:
                logger.error(f"保存到文件缓存失败: {str(e)}")

    def _get_file_cache_path(self) -> str:
        """获取文件缓存路径"""
        # 获取 uploads 目录
        uploads_dir = os.path.dirname(os.path.dirname(self.file_path))
        # 创建 cache 目录
        cache_dir = os.path.join(uploads_dir, 'cache')
        os.makedirs(cache_dir, exist_ok=True)
        return os.path.join(cache_dir, f"{self.file_hash}_text.json")

    def _process_pdf(self) -> None:
        """处理 PDF 文件并提取所有页面的文本"""
        if not os.path.exists(self.file_path):
            raise FileNotFoundError(f"文件不存在: {self.file_path}")

        file_ext = os.path.splitext(self.file_path)[1].lower()
        if file_ext != '.pdf':
            raise ValueError(f"不支持的文件格式: {file_ext}，只支持 PDF 文件")

        try:
            with fitz.open(self.file_path) as doc:
                total_pages = len(doc)
                logger.info(f"开始处理 PDF 文件，共 {total_pages} 页")
                
                for page_num in range(total_pages):
                    page = doc[page_num]
                    text = page.get_text()
                    
                    if not text.strip():
                        logger.warning(f"第 {page_num + 1} 页是空白页或无法提取文本")
                        continue
                        
                    self.text_by_page[str(page_num)] = text
                    logger.debug(f"已提取第 {page_num + 1} 页文本")
                
                logger.info(f"成功提取 {len(self.text_by_page)} 页文本")
                
                # 保存处理后的数据，包括时间戳
                self.processed_data = {
                    'file_hash': self.file_hash,
                    'total_pages': total_pages,
                    'text_by_page': self.text_by_page,
                    'processed_time': time.time()
                }
        except Exception as e:
            logger.error(f"处理 PDF 文件失败: {str(e)}")
            raise

    def get_page_count(self) -> int:
        """获取 PDF 总页数"""
        return len(self.text_by_page)

    def get_text(self, page_number: int) -> Optional[str]:
        """获取指定页码的文本"""
        return self.text_by_page.get(str(page_number))

    def get_all_texts(self) -> Dict[str, str]:
        """获取所有页面的文本"""
        return self.text_by_page 